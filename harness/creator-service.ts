// Bounded native update only. Existing origins, RP, database and operator persist.
import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  CommunityError,
  canonical,
  insist,
} from "../packages/community/common.ts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import {
  cfLoginToken,
  operatorEnvironment,
  type OperatorOptions,
} from "../apps/community-wizard/server/operator.ts";
import {
  DeploymentFailure,
  runWithDiagnostics,
} from "../apps/community-wizard/server/diagnostics.ts";
import { inspectPrivateFiles } from "../apps/community-wizard/server/state-inspection.ts";
import { privateDirectory } from "../apps/community-wizard/server/state.ts";
import { creatorPackage, writeCreatorPackage } from "./creator-package.ts";
import {
  creatorAccount,
  restoreCreatorState,
  verifyCreatorPredecessor,
  verifyCreatorSuccessor,
} from "./creator-state.ts";
import { creatorInventory, creatorRemoteModules } from "./creator-inventory.ts";
import {
  adoptReviewedUpdate,
  reviewedPredecessor,
  finishReviewedUpdate,
} from "./reviewed-update.ts";
import { privateJson } from "./private-json.ts";

const base = join(homedir(), ".local/state/pirate-first-song-managed-20261105"),
  directory = join(base, "creator-service");
async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
      options: {
        execute: { type: "boolean" },
        preflight: { type: "boolean" },
        "write-plan": { type: "boolean" },
        "expected-profile": { type: "string" },
        "reviewed-update": { type: "boolean" },
      },
    }),
    packaged = await creatorPackage(),
    { profile, profileHash } = packaged;
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.creator-update-plan.json",
      JSON.stringify(packaged, null, 2) + "\n",
    );
  if (!values.execute && !values.preflight) {
    console.log(JSON.stringify(packaged, null, 2));
    return;
  }
  if (values.execute)
    insist(
      values["expected-profile"] === profileHash,
      "creator_profile_not_reviewed",
      409,
    );
  const safe = operatorEnvironment(process.env),
    options: OperatorOptions = {
      directory: base,
      projectId: profile.stateProtection.projectId,
      environment: "staging",
      secretPath: profile.stateProtection.path,
      site: "https://app.infisical.com",
      profile: "",
      mode: "cf-login",
      cfProfile: "default",
      port: "8791",
      accountId: creatorAccount,
      check: false,
    },
    token = await cfLoginToken(options, safe),
    cloudEnv = {
      ...safe,
      CLOUDFLARE_ACCOUNT_ID: creatorAccount,
      CLOUDFLARE_API_TOKEN: token,
    },
    before = await creatorInventory(cloudEnv),
    successorModules = {
      "index.js": profile.artifacts["worker/index.js"],
      "ika.wasm": profile.artifacts["worker/ika.wasm"],
    };
  for (const name of ["pirate-wallet-test", "pirate-creator-spike"]) {
    const modules = await creatorRemoteModules(token, name);
    insist(
      canonical(modules) === canonical(profile.predecessorModules) ||
        canonical(modules) === canonical(successorModules),
      "creator_live_source_changed",
      409,
    );
  }
  const sdk = await infisicalAuth().client(),
    get = async (reference: {
      projectId: string;
      environment: string;
      path: string;
      name: string;
    }) => {
      const secret = await sdk.secrets().getSecret({
        projectId: reference.projectId,
        environment: reference.environment,
        secretPath: reference.path,
        secretName: reference.name,
        includeImports: false,
        expandSecretReferences: false,
      });
      insist(secret.secretValue, "creator_managed_binding_missing", 503);
      return secret.secretValue;
    },
    password = await get(profile.stateProtection),
    suiKey = await get(profile.operatorCredential);
  insist(
    Ed25519Keypair.fromSecretKey(suiKey).toSuiAddress() === profile.operator,
    "creator_operator_changed",
    409,
  );
  insist(
    Buffer.byteLength(password) >= 32,
    "creator_state_password_too_short",
    503,
  );
  await verifyCreatorPredecessor(profile.predecessorState, suiKey);
  await verifyCreatorSuccessor(
    join(directory, "deployment/infra/.alchemy/state"),
    profile.predecessorState,
    password,
    suiKey,
  );
  await reviewedPredecessor(directory, packaged);
  if (!values.execute) {
    console.log(
      JSON.stringify({
        profileHash,
        before,
        servingModules: "qualified predecessor or exact successor",
        managedBindings:
          "existing native key matches historical state; state password available",
      }),
    );
    return;
  }
  await privateDirectory(directory);
  const lockPath = join(directory, "execution.lock"),
    lock = await open(lockPath, "wx", 0o600),
    identity = canonical({
      profileHash,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  await lock.writeFile(identity);
  await lock.sync();
  try {
    const completed = await privateJson(
      join(directory, "deployment-result.json"),
    );
    if (completed?.profileHash === profileHash) {
      for (const origin of profile.origins) {
        const response = await fetch(origin + "/api/health", {
            redirect: "manual",
            signal: AbortSignal.timeout(30000),
          }),
          body = (await response.json()) as { profileHash: string };
        insist(
          response.ok &&
            body.profileHash === profileHash &&
            canonical(
              await creatorRemoteModules(
                token,
                new URL(origin).hostname.split(".")[0]!,
              ),
            ) === canonical(successorModules),
          "creator_completed_release_not_live",
          503,
        );
      }
      console.log(
        JSON.stringify(
          {
            ...completed,
            reconciliation: "committed success verified; no apply repeated",
          },
          null,
          2,
        ),
      );
      return;
    }
    const deadline = Date.now() + profile.bounds.executionSeconds * 1000;
    let existing: { profileHash: string } | null = null;
    try {
      existing = JSON.parse(
        await readFile(join(directory, "execution.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    insist(existing, "creator_update_execution_missing", 409);
    if (existing.profileHash !== profileHash) {
      insist(
        values["reviewed-update"],
        "creator_reviewed_update_flag_required",
        409,
      );
      await adoptReviewedUpdate(directory, packaged, {
        "deployment/infra/node_modules": resolve(
          "apps/creator-spike/infra/node_modules",
        ),
      });
    }
    const cwd = await writeCreatorPackage(directory);
    await restoreCreatorState(
      join(cwd, ".alchemy/state"),
      profile.predecessorState,
      password,
      suiKey,
    );
    const secrets = [token, password, suiKey],
      env = {
        ...cloudEnv,
        SUI_OPERATOR_SECRET_KEY: suiKey,
        PIRATE_WIZARD_STATE_PASSWORD: password,
        NATIVE_PROFILE_HASH: profileHash,
      },
      logs: string[] = [];
    for (const phase of ["plan", "deploy"]) {
      await inspectPrivateFiles(cwd, secrets);
      await inspectPrivateFiles(join(directory, "deployment/dist"), secrets);
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      insist(remaining > 0, "creator_update_window_expired", 409);
      logs.push(
        await runWithDiagnostics(
          "/usr/bin/timeout",
          [
            "--signal=TERM",
            "--kill-after=15s",
            `${remaining}s`,
            resolve("apps/creator-spike/infra/node_modules/.bin/alchemy"),
            phase,
            "--stage",
            "testnet",
            "--no-input",
            ...(phase === "deploy" ? ["--yes"] : []),
          ],
          { cwd, env, directory, password, phase: `creator-${phase}` },
        ),
      );
      await inspectPrivateFiles(cwd, secrets);
      await inspectPrivateFiles(join(directory, "deployment/dist"), secrets);
    }
    const health = [];
    for (const origin of profile.origins) {
      const response = await fetch(origin + "/api/health", {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        }),
        body = (await response.json()) as {
          profileHash: string;
          testnet: boolean;
        };
      insist(
        response.ok &&
          body.profileHash === profileHash &&
          body.testnet === true,
        "creator_update_health_unqualified",
        503,
      );
      health.push({ origin, status: response.status, body });
      const name = new URL(origin).hostname.split(".")[0]!;
      insist(
        canonical(await creatorRemoteModules(token, name)) ===
          canonical(successorModules),
        "creator_deployed_modules_changed",
        503,
      );
    }
    const after = await creatorInventory(cloudEnv),
      result = {
        profileHash,
        before,
        after,
        health,
        logs,
        historicalState:
          "original preserved unchanged; separate encrypted successor scanned",
        nativeTransactions: 0,
        providerRequests: 0,
      };
    await finishReviewedUpdate(directory, packaged, result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await lock.close();
    insist(
      (await readFile(lockPath, "utf8")) === identity,
      "creator_update_lock_changed",
      409,
    );
    await unlink(lockPath);
  }
}
main().catch((error) => {
  console.error(
    error instanceof CommunityError
      ? error.code
      : error instanceof DeploymentFailure
        ? error.message
        : "creator_update_failed; preserve state and reconcile before retry",
  );
  process.exitCode = 1;
});
