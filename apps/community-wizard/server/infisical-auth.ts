import { execFile } from "node:child_process";
import { InfisicalSDK } from "@infisical/sdk";
import { SetupError } from "./model.ts";

export interface InfisicalConnection {
  mode: "cli" | "machine";
  siteUrl: string;
}
export type CliRunner = (args: string[]) => Promise<string>;

export function siteOrigin(value: string): string {
  try {
    const site = new URL(value);
    if (
      site.protocol !== "https:" ||
      site.username ||
      site.password ||
      site.search ||
      site.hash ||
      !["/", "/api", "/api/"].includes(site.pathname)
    )
      throw new Error();
    return site.origin;
  } catch {
    throw new SetupError(
      "Configure a trusted Infisical HTTPS origin on the runner.",
      409,
    );
  }
}

// Neither process output nor child-process errors may escape this boundary.
export function cliRunner(env: NodeJS.ProcessEnv): CliRunner {
  const childEnv: NodeJS.ProcessEnv = {
    CI: "true",
    NO_COLOR: "1",
    BROWSER: "false",
    DO_NOT_TRACK: "1",
    INFISICAL_DISABLE_TELEMETRY: "1",
  };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    if (env[name]) childEnv[name] = env[name];
  return (args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "infisical",
        args,
        {
          env: childEnv,
          timeout: 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 65_536,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => {
          if (error)
            reject(
              new SetupError(
                "Infisical CLI access failed. Install the CLI, sign in on this computer, then connect again. CLI output is withheld.",
                409,
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.end();
    });
}

export function infisicalAuth(
  env: NodeJS.ProcessEnv = process.env,
  runCli: CliRunner = cliRunner(env),
) {
  const mode =
    env.INFISICAL_AUTH_MODE ??
    (env.INFISICAL_CLIENT_ID || env.INFISICAL_CLIENT_SECRET
      ? "machine"
      : "cli");
  if (mode !== "cli" && mode !== "machine")
    throw new SetupError("INFISICAL_AUTH_MODE must be cli or machine.", 409);
  const siteUrl = siteOrigin(
    env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
  );
  const connection: InfisicalConnection = { mode, siteUrl };
  const selectedProfile = env.INFISICAL_PROFILE;
  const clientId = env.INFISICAL_CLIENT_ID;
  const clientSecret = env.INFISICAL_CLIENT_SECRET;
  const common = ["--silent", "--domain", `${siteUrl}/api`];
  return {
    connection,
    async client() {
      const sdk = new InfisicalSDK({ siteUrl });
      if (mode === "machine") {
        if (!clientId || !clientSecret)
          throw new SetupError(
            "Set both Infisical machine credentials, or select CLI login on the runner.",
            409,
          );
        await sdk.auth().universalAuth.login({ clientId, clientSecret });
        return sdk;
      }
      try {
        const selection = selectedProfile ? ["--profile", selectedProfile] : [];
        const status = JSON.parse(
          await runCli(["login", "status", "--json", ...common, ...selection]),
        );
        const sessions: unknown[] = Array.isArray(status.sessions)
          ? status.sessions
          : [];
        const users = sessions.filter(
          (value): value is Record<string, unknown> =>
            Boolean(
              value &&
                typeof value === "object" &&
                (value as Record<string, unknown>).principalType === "user",
            ),
        );
        const user = users.length === 1 ? users[0] : undefined;
        if (
          !user ||
          user.status !== "authenticated" ||
          (user.verification as { state?: string } | undefined)?.state !==
            "verified" ||
          typeof user.domain !== "string" ||
          siteOrigin(user.domain) !== siteUrl ||
          typeof user.profile !== "string" ||
          !user.profile ||
          user.profile.length > 512 ||
          /[\x00-\x1f]/.test(user.profile) ||
          (selectedProfile && selectedProfile !== user.profile)
        )
          throw new Error();
        // Pin the profile inspected above, rather than reselecting a changed default.
        const token = (
          await runCli([
            "user",
            "get",
            "token",
            "--plain",
            ...common,
            "--profile",
            user.profile,
          ])
        ).trim();
        if (
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
          token.length > 16_384
        )
          throw new Error();
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString(),
        );
        if (
          !Number.isFinite(payload.exp) ||
          payload.exp * 1000 <= Date.now() + 30_000
        )
          throw new Error();
        // This parse is a freshness check, not signature verification. Infisical
        // authorizes every scoped API request. No token is cached or serialized.
        sdk.auth().accessToken(token);
        return sdk;
      } catch {
        throw new SetupError(
          "Could not use an active Infisical CLI login for this instance. Check the CLI version, selected profile and login, then connect again. No session details are returned.",
          409,
        );
      }
    },
  };
}
