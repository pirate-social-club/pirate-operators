import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { statePassword } from "../infra/protected-data.ts";
import {
  cfLoginToken,
  credential,
  executable,
  operatorEnvironment,
  OperatorError,
  operatorOptions,
  operatorUsage,
} from "./operator.ts";

async function main() {
  process.umask(0o077);
  let args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(operatorUsage);
    return;
  }
  if (!process.execve)
    throw new OperatorError(
      "The operator launcher requires Node 24 on a POSIX system.",
    );
  const injected = args[0] === "--injected";
  if (injected) args = args.slice(1);
  const options = await operatorOptions(
    args,
    injected ? operatorEnvironment(process.env) : process.env,
  );
  if (options.check) {
    console.log(JSON.stringify(options, null, 2));
    return;
  }
  const env = operatorEnvironment(process.env);
  const tsx = fileURLToPath(import.meta.resolve("tsx"));
  if (!injected) {
    const infisical = await executable("infisical", env);
    if (options.mode === "cf-login")
      console.log(
        "Using the selected personal cf login. Its account permissions are not restricted to this community's resource prefix.",
      );
    // No ambient tokens/passwords or Node options enter the injection command.
    // Process replacement preserves terminal signals instead of adding a shell.
    process.chdir(options.directory);
    process.execve(
      infisical,
      [
        infisical,
        "run",
        "--silent",
        "--telemetry=false",
        "--domain",
        `${options.site}/api`,
        "--projectId",
        options.projectId,
        "--env",
        options.environment,
        "--path",
        options.secretPath,
        "--include-imports=false",
        "--expand=false",
        "--recursive=false",
        "--secret-overriding=false",
        ...(options.profile ? ["--profile", options.profile] : []),
        "--",
        process.execPath,
        "--import",
        tsx,
        fileURLToPath(import.meta.url),
        "--injected",
        "--state-dir",
        options.directory,
        "--runner-secrets-path",
        options.secretPath,
        "--project-id",
        options.projectId,
        "--environment",
        options.environment,
        "--port",
        options.port,
        "--cloudflare-auth",
        options.mode,
        "--cf-profile",
        options.cfProfile,
        "--infisical-site",
        options.site,
        ...(options.profile ? ["--infisical-profile", options.profile] : []),
      ],
      env,
    );
  } else {
    const password = statePassword();
    const token =
      options.mode === "cf-login"
        ? await cfLoginToken(options, process.env)
        : credential(process.env.CLOUDFLARE_API_TOKEN);
    // The dedicated trusted Infisical folder supplies only the password and,
    // in token mode, a Cloudflare token. Do not forward arbitrary injected keys.
    Object.assign(env, {
      PIRATE_WIZARD_STATE_PASSWORD: password,
      CLOUDFLARE_API_TOKEN: token,
      PIRATE_WIZARD_STATE_DIR: options.directory,
      PIRATE_WIZARD_PORT: options.port,
      INFISICAL_AUTH_MODE: "cli",
      INFISICAL_SITE_URL: options.site,
      ...(options.profile ? { INFISICAL_PROFILE: options.profile } : {}),
    });
    process.chdir(options.directory);
    process.execve(
      process.execPath,
      [
        process.execPath,
        "--import",
        tsx,
        fileURLToPath(new URL("./start.ts", import.meta.url)),
      ],
      env,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof OperatorError
        ? error.message
        : "Operator launch failed. Check private setup, CLI login and the dedicated runner-secret folder. Details are withheld.",
    );
    process.exitCode = 1;
  });
}
