import { execFile } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { object, settingsFrom } from "./model.ts";
import { siteOrigin } from "./infisical-auth.ts";

export const operatorUsage = `Usage: npm run start:operator --
  --state-dir /absolute/existing/state --runner-secrets-path /community-runner
  [--project-id UUID --environment staging] [--port 8789]
  [--cloudflare-auth api-token|cf-login] [--cf-profile default]
  [--infisical-profile PROFILE --infisical-site https://app.infisical.com] [--check]

Save initial settings with npm start first. Project/environment default to those
settings; managed communities must specify them. API-token mode is the default:
the dedicated Infisical folder must contain PIRATE_WIZARD_STATE_PASSWORD and
CLOUDFLARE_API_TOKEN. cf-login explicitly uses the selected personal cf profile.
--check validates nonsecret launch settings only; it does not authenticate or
start the runner. This command never deploys or removes a lock/state file.`;

export class OperatorError extends Error {}

export function operatorEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const clean: Record<string, string> = {
    CI: "true",
    NO_COLOR: "1",
    BROWSER: "false",
    DO_NOT_TRACK: "1",
    CF_SEND_TELEMETRY: "false",
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
    if (env[name]) clean[name] = env[name]!;
  return clean;
}

async function privateJson(file: string): Promise<Record<string, unknown>> {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.size > 65536 ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new OperatorError(
      "Expected a private, user-owned configuration file.",
    );
  return object(JSON.parse(await readFile(file, "utf8")));
}

export async function operatorOptions(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "state-dir": { type: "string" },
      "runner-secrets-path": { type: "string" },
      "project-id": { type: "string" },
      environment: { type: "string" },
      port: { type: "string" },
      "cloudflare-auth": { type: "string" },
      "cf-profile": { type: "string" },
      "infisical-profile": { type: "string" },
      "infisical-site": { type: "string" },
      check: { type: "boolean" },
    },
  });
  const text = (key: keyof typeof values) =>
    typeof values[key] === "string" ? (values[key] as string) : "";
  const selected = text("state-dir");
  if (!selected || !isAbsolute(selected))
    throw new OperatorError(
      "Choose an explicit absolute state directory; no default or fallback is used.",
    );
  const directory = await realpath(selected);
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new OperatorError(
      "Use an existing private state directory owned by this user.",
    );
  for (let parent = directory; ; parent = dirname(parent)) {
    if (
      await access(join(parent, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new OperatorError(
        "Operator state must be outside Git repositories.",
      );
    if (dirname(parent) === parent) break;
  }
  if (
    await access(join(directory, "runner.lock")).then(
      () => true,
      () => false,
    )
  )
    throw new OperatorError(
      "State is locked. Follow the documented process checks; the launcher never removes locks.",
    );
  const state = await privateJson(join(directory, "setup.json"));
  if (state.version !== 1 || !state.settings)
    throw new OperatorError(
      "Save initial wizard settings before using the operator launcher.",
    );
  const settings = settingsFrom(state.settings);
  const projectId = text("project-id") || settings.projectId;
  const environment = text("environment") || settings.environment;
  const secretPath = text("runner-secrets-path");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId,
    ) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(environment)
  )
    throw new OperatorError(
      "Specify the runner-secret project UUID and environment.",
    );
  if (
    !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,7}$/.test(secretPath) ||
    secretPath.length > 240 ||
    (projectId === settings.projectId &&
      environment === settings.environment &&
      secretPath === settings.secretPath)
  )
    throw new OperatorError(
      "Choose a dedicated runner-secret folder, separate from provider keys.",
    );
  if (
    state.secretStoreSite !== undefined &&
    typeof state.secretStoreSite !== "string"
  )
    throw new OperatorError("Invalid saved Infisical instance.");
  const site = siteOrigin(
    text("infisical-site") ||
      env.INFISICAL_SITE_URL ||
      state.secretStoreSite ||
      "https://app.infisical.com",
  );
  if (state.secretStoreSite && site !== state.secretStoreSite)
    throw new OperatorError(
      "Use the Infisical instance already bound to this state.",
    );
  const mode = text("cloudflare-auth") || "api-token";
  if (mode !== "api-token" && mode !== "cf-login")
    throw new OperatorError(
      "Cloudflare authentication must be api-token or cf-login.",
    );
  const cfProfile = text("cf-profile") || "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfProfile))
    throw new OperatorError("Choose an existing cf profile name.");
  const profile = text("infisical-profile") || env.INFISICAL_PROFILE || "";
  if (profile.length > 128 || /[\x00-\x1f]/.test(profile))
    throw new OperatorError("Invalid Infisical profile.");
  const port = text("port") || "8789";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new OperatorError("Choose a valid loopback port.");
  return {
    directory,
    projectId,
    environment,
    secretPath,
    site,
    profile,
    mode,
    cfProfile,
    port,
    accountId: settings.accountId,
    check: values.check === true,
  };
}

export type OperatorOptions = Awaited<ReturnType<typeof operatorOptions>>;

export async function executable(name: string, env: NodeJS.ProcessEnv) {
  for (const entry of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(entry)) continue;
    const path = join(entry, name);
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new OperatorError(`Install ${name} on the operator's PATH.`);
}

export async function cfLoginToken(
  options: OperatorOptions,
  env: NodeJS.ProcessEnv,
) {
  try {
    const cf = await executable("cf", env);
    const output = await new Promise<string>((done, fail) => {
      const child = execFile(
        cf,
        ["auth", "whoami", "--profile", options.cfProfile],
        {
          cwd: options.directory,
          env: operatorEnvironment(env),
          encoding: "utf8",
          timeout: 30000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
        },
        (error, stdout) => (error ? fail(new Error()) : done(stdout)),
      );
      child.stdin?.end();
    });
    const status = object(JSON.parse(output));
    const prefix = "OAuth token from ";
    if (
      status.authenticated !== true ||
      status.tokenValid !== true ||
      !Array.isArray(status.accounts) ||
      !status.accounts.some(
        (a: { id?: string }) => a?.id === options.accountId,
      ) ||
      typeof status.authSource !== "string" ||
      !status.authSource.startsWith(prefix)
    )
      throw new Error();
    // cf owns location/profile resolution and refresh. Read only the selected
    // file it reports; do not fall back to another profile or ambient token.
    const file = status.authSource.slice(prefix.length);
    if (!isAbsolute(file) || basename(file) !== `${options.cfProfile}.json`)
      throw new Error();
    const login = await privateJson(file);
    if (
      typeof login.expiration_time !== "string" ||
      !Number.isFinite(Date.parse(login.expiration_time)) ||
      Date.parse(login.expiration_time) <= Date.now() + 60000
    )
      throw new Error();
    return credential(login.oauth_token);
  } catch {
    throw new OperatorError(
      "Could not refresh and verify the selected cf login for this account. Sign in with cf outside the launcher and retry; CLI output is withheld.",
    );
  }
}

export function credential(value: unknown): string {
  if (typeof value !== "string" || !/^[^\s\x00]{16,16384}$/.test(value))
    throw new OperatorError(
      "The selected Cloudflare credential is missing or invalid.",
    );
  return value;
}
