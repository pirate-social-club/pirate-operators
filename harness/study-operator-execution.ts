import type { spawn, SpawnOptions } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  symlink,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { insist, object, canonical } from "../packages/community/common.ts";
import { seal } from "../apps/community-wizard/infra/protected-data.ts";
import { durableJson, digest, privateJson } from "./private-json.ts";
import {
  communityDependencyModules,
  verifyCommunityDependencies,
} from "./community-dependencies.ts";
import {
  operatorCwd,
  releaseDirectory,
  readPlanReview,
} from "./study-operator-private.ts";
import {
  operatorProfile,
  type OperatorProfile,
} from "./study-operator-profile.ts";
import type { prepareOperatorPackage } from "./study-operator-package.ts";
export function redactOperatorOutput(
  output: string,
  secrets: readonly string[],
) {
  for (const value of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    output = output.replaceAll(value, "[redacted]");
  return output;
}
export function operatorDeployCommand(
  profile: OperatorProfile,
  hash: string,
  now: number,
  operation: "deploy" | "plan" = "deploy",
) {
  profile = operatorProfile(profile);
  const seconds = Math.floor(
    (Date.parse(profile.window.deadline) - now) / 1000,
  );
  insist(
    seconds > 0 && seconds <= 900,
    "study_operator_apply_window_expired",
    409,
  );
  return {
    executable: "/usr/bin/timeout",
    args: [
      "--signal=TERM",
      "--kill-after=15s",
      `${seconds}s`,
      join(communityDependencyModules, ".bin/alchemy"),
      operation,
      join(releaseDirectory(hash), "package/learning-testnet.alchemy.ts"),
      "--env-file",
      "/dev/null",
      "--stage",
      "testnet",
      "--no-input",
      ...(operation === "deploy" ? ["--yes"] : []),
    ],
    cwd: operatorCwd(),
  };
}
export async function writeOperatorPackage(
  profile: OperatorProfile,
  hash: string,
  prepared: Awaited<ReturnType<typeof prepareOperatorPackage>>,
  operation: "deploy" | "plan" = "deploy",
) {
  await verifyCommunityDependencies();
  if (operation === "deploy") {
    const review = await readPlanReview(profile);
    const files = Object.fromEntries(
      Object.entries(prepared.files).map(([n, b]) => [n, digest(b)]),
    );
    insist(
      canonical(review.receipt.packageFiles) === canonical(files),
      "study_operator_reviewed_package_changed",
      409,
    );
  }
  const directory = join(releaseDirectory(hash), "package");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  insist(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid!() &&
      !(stat.mode & 0o077),
    "study_operator_package_not_private",
    409,
  );
  for (const [name, bytes] of Object.entries(prepared.files)) {
    insist(
      /^[a-z0-9][a-z0-9.-]*\.(ts|mjs)$/i.test(name),
      "study_operator_package_name_invalid",
      409,
    );
    const path = join(directory, name);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      insist(
        digest(await readFile(path)) === digest(bytes),
        "study_operator_prepared_package_changed",
        409,
      );
    } finally {
      await handle?.close();
    }
  }
  const dependencies = join(directory, "node_modules");
  try {
    await symlink(communityDependencyModules, dependencies, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  insist(
    (await realpath(dependencies)) ===
      (await realpath(communityDependencyModules)),
    "study_operator_dependency_link_changed",
    409,
  );
  await durableJson(join(directory, "package-manifest.json"), {
    schema: "pirate.study-operator-package/1",
    profileHash: hash,
    files: Object.fromEntries(
      Object.entries(prepared.files).map(([n, b]) => [n, digest(b)]),
    ),
  });
  return directory;
}
export async function deployOperatorOnce(
  profile: OperatorProfile,
  hash: string,
  env: NodeJS.ProcessEnv,
  password: string,
  secrets: readonly string[],
  now: number,
  io: {
    spawn: typeof spawn;
    assertDispatch: () => Promise<void>;
    operation?: "deploy" | "plan";
    persistDiagnostic?: (value: Record<string, unknown>) => Promise<string>;
  },
) {
  insist(
    typeof io?.spawn === "function" && typeof io.assertDispatch === "function",
    "study_operator_child_dependency_missing",
    409,
  );
  assertOperatorChildEnvironment(profile, env, password);
  await io.assertDispatch();
  insist(
    !io.operation || io.operation === "deploy" || io.operation === "plan",
    "study_operator_child_operation_invalid",
    409,
  );
  const command = operatorDeployCommand(profile, hash, now, io.operation),
    logs = join(releaseDirectory(hash), "diagnostics");
  if (!io.persistDiagnostic)
    await mkdir(logs, { recursive: true, mode: 0o700 });
  const response = await new Promise<{
    code: number | null;
    started: boolean;
    output: string;
    truncated: boolean;
  }>((done) => {
    let output = "",
      bytes = 0,
      truncated = false,
      settled = false;
    const child = io.spawn(command.executable, command.args, {
      cwd: command.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    } as SpawnOptions & { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number | null, started: boolean) => {
      if (settled) return;
      settled = true;
      done({ code, started, output, truncated });
    };
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 2 * 1024 * 1024) output += chunk.toString();
      else if (!truncated) {
        truncated = true;
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
        kill.unref();
      }
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.once("error", () => finish(null, false));
    child.once("close", (code) => finish(code, true));
  });
  const redacted = redactOperatorOutput(response.output, secrets),
    safe = { ...response, output: redacted };
  let id: string;
  if (io.persistDiagnostic) id = await io.persistDiagnostic(safe);
  else {
    id = `operator-${Date.now()}-${randomUUID()}.enc`;
    const path = join(logs, id),
      handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        seal(JSON.stringify(safe), password, "operator-diagnostic:" + id),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  insist(
    response.started && response.code === 0 && !response.truncated,
    "study_operator_apply_outcome_unknown",
    409,
  );
  return {
    logId: id,
    ...(io.operation === "plan" ? { planOutput: redacted, command } : {}),
  };
}

// No process.env merge or dotenv fallback is permitted at this boundary.
export function assertOperatorChildEnvironment(
  profile: OperatorProfile,
  env: NodeJS.ProcessEnv,
  password: string,
) {
  const required = [
    "PATH",
    "HOME",
    "CI",
    "NO_COLOR",
    "ALCHEMY_TELEMETRY_DISABLED",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "PIRATE_WIZARD_STATE_PASSWORD",
    "LEARNING_COMMUNITY_ID",
    "LEARNING_PROFILE",
    "LEARNING_RESULTS_CONTRACT",
    "LEARNING_RESULTS_V3_CONTRACT",
    "LEARNING_GRADER_ADDRESS",
    "LEARNING_ISSUER_ADDRESS",
    "LEARNING_OPERATOR_PRIVATE_KEY",
    "LEARNING_ELEVENLABS_API_KEY",
    "LEARNING_SPONSOR_CAP_WEI",
    "LEARNING_GAS_PRICE_WEI",
    "LEARNING_GAS_LIMIT",
    "LEARNING_DATA_FEE_WEI",
    "LEARNING_SPEECH_DAILY_LIMIT",
    "LEARNING_QUOTE_VALID_FROM",
    "LEARNING_QUOTE_VALID_UNTIL",
  ];
  const allowed = new Set([
    ...required,
    "TMPDIR",
    "LEARNING_APPROVED_ACTIVATION_ACCOUNT",
  ]);
  insist(
    required.every((k) => typeof env[k] === "string" && env[k]!.length > 0) &&
      Object.keys(env).every((k) => allowed.has(k)),
    "study_operator_child_environment_incomplete",
    409,
  );
  const expected = {
    CI: "true",
    NO_COLOR: "1",
    ALCHEMY_TELEMETRY_DISABLED: "1",
    CLOUDFLARE_ACCOUNT_ID: profile.worker.accountId,
    PIRATE_WIZARD_STATE_PASSWORD: password,
    LEARNING_COMMUNITY_ID: profile.selection.communityId,
    LEARNING_PROFILE: "pirate-learning-testnet-v3",
    LEARNING_RESULTS_CONTRACT: profile.selection.resultsV2.contract,
    LEARNING_RESULTS_V3_CONTRACT: profile.selection.resultsV3.contract,
    LEARNING_SPONSOR_CAP_WEI: profile.retained.limits.sponsorCapWei,
    LEARNING_GAS_PRICE_WEI: profile.retained.limits.gasPriceWei,
    LEARNING_GAS_LIMIT: profile.retained.limits.gasLimit,
    LEARNING_DATA_FEE_WEI: profile.retained.limits.dataFeeWei,
    LEARNING_SPEECH_DAILY_LIMIT: "0",
    LEARNING_QUOTE_VALID_FROM: String(profile.retained.quoteValidFrom),
    LEARNING_QUOTE_VALID_UNTIL: String(profile.retained.quoteValidUntil),
  };
  insist(
    Object.entries(expected).every(([k, v]) => env[k] === v) &&
      /^0x[0-9a-f]{64}$/i.test(env.LEARNING_OPERATOR_PRIVATE_KEY!) &&
      (!env.LEARNING_APPROVED_ACTIVATION_ACCOUNT ||
        /^0x[0-9a-f]{40}$/.test(env.LEARNING_APPROVED_ACTIVATION_ACCOUNT)),
    "study_operator_child_environment_changed",
    409,
  );
}

export async function assertDispatchedPackage(
  profile: OperatorProfile,
  hash: string,
  prepared: Awaited<ReturnType<typeof prepareOperatorPackage>>,
  expectedState: "prepared" | "dispatched" = "dispatched",
) {
  const execution = await privateJson(
    join(releaseDirectory(hash), "execution.json"),
  );
  insist(
    execution?.schema === "pirate.study-operator-execution/1" &&
      execution.profileHash === hash &&
      execution.state === expectedState &&
      (expectedState === "prepared" ||
        Number.isFinite(Date.parse(String(execution.dispatchedAt)))),
    "study_operator_not_dispatched",
    409,
  );
  const directory = join(releaseDirectory(hash), "package");
  const manifest = await privateJson(join(directory, "package-manifest.json"));
  const files = Object.fromEntries(
    Object.entries(prepared.files).map(([n, b]) => [n, digest(b)]),
  );
  insist(
    manifest?.schema === "pirate.study-operator-package/1" &&
      manifest.profileHash === hash &&
      canonical(manifest.files) === canonical(files),
    "study_operator_package_manifest_changed",
    409,
  );
  for (const [name, want] of Object.entries(files))
    insist(
      digest(await readFile(join(directory, name))) === want,
      "study_operator_package_bytes_changed",
      409,
    );
  insist(
    digest(prepared.files["operator.mjs"]!) === profile.artifact.sha256,
    "study_operator_package_artifact_changed",
    409,
  );
}
