import { execFile } from "node:child_process";
import { InfisicalSDK } from "@infisical/sdk";
import { requireThat, SetupFailure, type Plan, type Vault } from "./model.ts";

// Independently owned CLI authentication; no dependency on the changing wizard.
// The inspected login/token contract matches its approved Infisical CLI workflow.
export type Cli = (args: string[]) => Promise<string>;
export function cli(env: NodeJS.ProcessEnv = process.env): Cli {
  const childEnv: NodeJS.ProcessEnv = {
    CI: "true",
    NO_COLOR: "1",
    BROWSER: "false",
    DO_NOT_TRACK: "1",
    INFISICAL_DISABLE_TELEMETRY: "1",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    if (env[key]) childEnv[key] = env[key];
  return (args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "infisical",
        args,
        {
          env: childEnv,
          timeout: 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
          encoding: "utf8",
        },
        (error, stdout) =>
          error
            ? reject(new SetupFailure("infisical_login_required"))
            : resolve(stdout),
      );
      child.stdin?.end();
    });
}
export async function authenticatedSdk(run = cli()) {
  const common = ["--silent", "--domain", "https://app.infisical.com/api"];
  try {
    const status = JSON.parse(
      await run(["login", "status", "--json", ...common]),
    );
    const sessions = Array.isArray(status.sessions)
      ? status.sessions.filter(
          (s: Record<string, unknown>) => s.principalType === "user",
        )
      : [];
    requireThat(sessions.length === 1, "infisical_login_ambiguous");
    const user = sessions[0];
    requireThat(
      user.status === "authenticated" &&
        user.verification?.state === "verified" &&
        new URL(user.domain).origin === "https://app.infisical.com" &&
        typeof user.profile === "string" &&
        /^[^\x00-\x1f]{1,512}$/.test(user.profile),
      "infisical_login_invalid",
    );
    const token = (
      await run([
        "user",
        "get",
        "token",
        "--plain",
        ...common,
        "--profile",
        user.profile,
      ])
    ).trim();
    requireThat(
      token.length <= 16384 &&
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
      "infisical_login_invalid",
    );
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    requireThat(
      Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now() + 30000,
      "infisical_login_expired",
    );
    // Parsing checks expiry only. The service authorizes every scoped SDK request.
    const sdk = new InfisicalSDK({ siteUrl: "https://app.infisical.com" });
    sdk.auth().accessToken(token);
    return sdk;
  } catch {
    throw new SetupFailure("infisical_verified_login_required");
  }
}
export async function createVault(
  plan: Plan,
  sdk: InfisicalSDK,
): Promise<Vault> {
  const { projectId, environment, bootstrapPath, runtimePath } =
    plan.profile.vault;
  const runtime = `${runtimePath}/${plan.intent}`;
  // Only runtime folders are created; the owner explicitly prepares the bootstrap scope.
  let path = "/";
  for (const name of runtime.slice(1).split("/")) {
    const scope = { projectId, environment, path };
    const exists = async () =>
      (await sdk.folders().listFolders({ ...scope, recursive: false })).some(
        (f) => f.name === name,
      );
    if (!(await exists())) {
      try {
        await sdk.folders().create({ ...scope, name });
      } catch {
        requireThat(await exists(), "vault_folder_not_confirmed");
      }
      requireThat(await exists(), "vault_folder_not_confirmed");
    }
    path = `${path === "/" ? "" : path}/${name}`;
  }
  const scope = (zone: "bootstrap" | "runtime") => ({
    projectId,
    environment,
    secretPath: zone === "bootstrap" ? bootstrapPath : runtime,
    includeImports: false,
    expandSecretReferences: false,
  });
  const get = async (zone: "bootstrap" | "runtime", name: string) => {
    const options = scope(zone);
    const list = await sdk
      .secrets()
      .listSecrets({ ...options, recursive: false, viewSecretValue: false });
    if (!list.secrets.some((s) => s.secretKey === name)) return undefined;
    return (await sdk.secrets().getSecret({ ...options, secretName: name }))
      .secretValue;
  };
  return {
    get,
    async put(name, value) {
      requireThat(
        [
          "OPENAI_API_KEY",
          "ACRCLOUD_ACCESS_KEY",
          "ACRCLOUD_ACCESS_SECRET",
        ].includes(name),
        "runtime_secret_name_refused",
      );
      const old = await get("runtime", name);
      requireThat(
        old === undefined || old === value,
        "runtime_secret_conflict_no_overwrite",
      );
      if (old === undefined) {
        try {
          await sdk
            .secrets()
            .createSecret(name, { ...scope("runtime"), secretValue: value });
        } catch {
          requireThat(
            (await get("runtime", name)) === value,
            "runtime_secret_write_unconfirmed",
          );
        }
      }
      requireThat(
        (await get("runtime", name)) === value,
        "runtime_secret_readback_mismatch",
      );
    },
  };
}
