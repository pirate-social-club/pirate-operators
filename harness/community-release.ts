import { communityDependencyModules } from "./community-dependencies.ts";
import { qualifyApplicationPeers } from "./first-song-peers.ts";
import { qualifyRetainedState } from "./published-state.ts";
import { qualifyCommunityConsumer } from "./community-consumer.ts";
import { bindCommunityPublisher } from "./community-credentials.ts";
import { completedCommunityRelease } from "./community-result.ts";
import {
  adoptReviewedUpdate,
  reviewedPredecessor,
  finishReviewedUpdate,
} from "./reviewed-update.ts";
// Manual staging application upgrade. Dry plan by default; exact reviewed hash
// required for execution. Existing wizard state and resource identities remain.
import { readFile, writeFile, lstat, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import {
  cfLoginToken,
  operatorEnvironment,
  type OperatorOptions,
} from "../apps/community-wizard/server/operator.ts";
import { privateDirectory } from "../apps/community-wizard/server/state.ts";
import { inspectPrivateFiles } from "../apps/community-wizard/server/state-inspection.ts";
import {
  runWithDiagnostics,
  DeploymentFailure,
} from "../apps/community-wizard/server/diagnostics.ts";
import {
  CommunityError,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  communityInventory,
  communityRemoteModules,
  requireIdleCommunity,
} from "./community-inventory.ts";
import {
  communityPackage,
  writeCommunityPackage,
  communityBase,
  communityPrefix,
  communityAccount,
  communityOwned,
} from "./community-package.ts";
import {
  durableJson,
  restoreCommunityState,
  verifyCommunitySuccessor,
} from "./community-state.ts";

const directory = join(communityBase, "application-service");
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
    { profile, profileHash, bytes } = await communityPackage();
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.application-plan.json",
      JSON.stringify({ profileHash, profile }, null, 2) + "\n",
    );
  if (!values.execute && !values.preflight) {
    console.log(JSON.stringify({ profileHash, profile }, null, 2));
    return;
  }
  if (values.execute)
    insist(
      values["expected-profile"] === profileHash,
      "community_profile_not_reviewed",
      409,
    );
  const safe = operatorEnvironment(process.env),
    state = profile.stateProtection,
    options: OperatorOptions = {
      directory: communityBase,
      projectId: state.projectId,
      environment: "staging",
      secretPath: state.path,
      site: "https://app.infisical.com",
      profile: "",
      mode: "cf-login",
      cfProfile: "default",
      port: "8791",
      accountId: communityAccount,
      check: false,
    },
    token = await cfLoginToken(options, safe),
    cloudEnv = {
      ...safe,
      CLOUDFLARE_ACCOUNT_ID: communityAccount,
      CLOUDFLARE_API_TOKEN: token,
    };
  const inventory = () => communityInventory(cloudEnv);
  const before = await inventory();
  const previousPlan = object(
      JSON.parse(
        await readFile(profile.reviewedUpdate.previousPlanPath, "utf8"),
      ),
    ),
    previousProfile = object(previousPlan.profile);
  insist(
    previousPlan.profileHash === profile.reviewedUpdate.previousProfileHash,
    "community_previous_plan_changed",
    409,
  );
  const modules = await communityRemoteModules(token);
  insist(
    Object.keys(modules).length === 1 &&
      Object.values(modules).every(
        (h) => h === previousProfile.bundleSha256 || h === profile.bundleSha256,
      ),
    "community_live_source_changed",
    409,
  );
  if (process.env.PIRATE_RELEASE_DEBUG === "1") console.error("gate:application-health");
  const live = await fetch(profile.origin + "/health", {
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    }),
    health = object(await live.json());
  insist(
    live.ok &&
      health.planId === profile.planId &&
      health.schema === "pirate.community-application/1" &&
      (health.profileHash === profile.reviewedUpdate.previousProfileHash ||
        health.profileHash === profileHash),
    "community_live_profile_changed",
    409,
  );
  const sdk = await infisicalAuth().client();
  if (process.env.PIRATE_RELEASE_DEBUG === "1") console.error("gate:retained-state");
  const get = async (projectId: string, path: string, name: string) => {
    const secret = await sdk.secrets().getSecret({
      projectId,
      environment: "staging",
      secretPath: path,
      secretName: name,
      includeImports: false,
      expandSecretReferences: false,
    });
    insist(secret.secretValue, "community_existing_secret_unavailable", 503);
    return secret.secretValue;
  };
  const password = await get(
    state.projectId,
    state.path,
    "PIRATE_WIZARD_STATE_PASSWORD",
  );
  await verifyCommunitySuccessor(directory, profile, password);
  await reviewedPredecessor(directory, { profile, profileHash });
  await qualifyRetainedState(
    token,
    communityAccount,
    profile.curatedState,
    "application",
  );
  await qualifyCommunityConsumer(directory, password, cloudEnv);
  await qualifyApplicationPeers(profile, values["reviewed-update"] === true);
  if (!values.execute) {
    // Read-only ownership check: authenticate original state without restoring it.
    const { unseal } = await import(
        "../apps/community-wizard/infra/protected-data.ts"
      ),
      { assertCommunityState } = await import("./community-state.ts");
    for (const relative of Object.keys(profile.predecessorState))
      assertCommunityState(
        JSON.parse(
          unseal(
            await readFile(
              join(communityBase, "deployment/.alchemy/state", relative),
              "utf8",
            ),
            password,
            `alchemy-state:${relative}`,
          ),
        ),
        relative.split("/").at(-1)!.slice(0, -5),
      );
    console.log(
      JSON.stringify(
        {
          profileHash,
          before,
          modules,
          health,
          ownership: "authenticated original encrypted state",
          execution: "not started",
        },
        null,
        2,
      ),
    );
    return;
  }
  await privateDirectory(directory);
  const lockPath = join(directory, "execution.lock"),
    lock = await open(lockPath, "wx", 0o600),
    identity = JSON.stringify({
      pid: process.pid,
      profileHash,
      at: new Date().toISOString(),
    });
  await lock.writeFile(identity);
  await lock.sync();
  try {
    const completed = await completedCommunityRelease(
      directory,
      profile,
      profileHash,
      { inventory: before, modules, health },
    );
    if (completed) {
      console.log(
        JSON.stringify(
          {
            ...completed,
            reconciliation:
              "committed success matches fresh live identities, modules and health; no apply repeated",
          },
          null,
          2,
        ),
      );
      return;
    }
    const executionPath = join(directory, "execution.json");
    try {
      const existing = object(
        JSON.parse(await readFile(executionPath, "utf8")),
      );
      if (existing.profileHash !== profileHash) {
        insist(
          values["reviewed-update"],
          "community_reviewed_update_flag_required",
          409,
        );
        await adoptReviewedUpdate(
          directory,
          { profile, profileHash },
          {
            "deployment/node_modules": communityDependencyModules,
          },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableJson(executionPath, {
        profileHash,
        before,
        modules,
        health,
        startedAt: new Date().toISOString(),
      });
    }
    const deadline = Date.now() + profile.bounds.executionSeconds * 1000,
      keyPath = join(
        homedir(),
        ".config/pirate-operators/megaeth-testnet/keys.json",
      ),
      stat = await lstat(keyPath);
    insist(
      stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid!(),
      "community_publisher_file_not_private",
      409,
    );
    const keys = JSON.parse(await readFile(keyPath, "utf8")),
      publisherKey = keys.keys.operator;
    const issuerKey = keys.keys.communityAdmin;
    insist(
      keys.chainId === 6343 &&
        privateKeyToAccount(publisherKey).address.toLowerCase() ===
          profile.publisher,
      "community_publisher_identity_changed",
      409,
    );
    insist(
      privateKeyToAccount(issuerKey).address.toLowerCase() ===
        profile.learning.issuer,
      "learning_issuer_changed",
      409,
    );
    const speech = await get(
      profile.learning.providerCredential.projectId,
      profile.learning.providerCredential.path,
      profile.learning.providerCredential.key,
    );
    await bindCommunityPublisher(sdk, profile, publisherKey, get);
    await restoreCommunityState(directory, profile, password);
    const cwd = await writeCommunityPackage(
        directory,
        bytes,
        profile.migrations,
      ),
      env = {
        ...cloudEnv,
        PIRATE_WIZARD_STATE_PASSWORD: password,
        COMMUNITY_PUBLISHER_PRIVATE_KEY: publisherKey,
        APPLICATION_PROFILE_HASH: profileHash,
        CREATOR_PROFILE_HASH: profile.creatorProfileHash,
        MANAGED_PROFILE_HASH: profile.managedProfileHash,
        RELEASE_GRANT_HASH: profile.releaseGrant.sha256,
        REGISTRATION_OPERATOR_ADDRESS:
          profile.releaseGrant.registration.operator,
        POSTING_EXPIRES_AT: String(profile.releaseGrant.expiresAt),
        LEARNING_ELEVENLABS_API_KEY: speech,
        LEARNING_OPERATOR_ADDRESS: profile.learning.operator,
        LEARNING_OPERATOR_ORIGIN: profile.learning.operatorOrigin,
        LEARNING_ISSUER_ADDRESS: profile.learning.issuer,
        LEARNING_ISSUER_PRIVATE_KEY: issuerKey,
      },
      secrets = [password, publisherKey, token, issuerKey, speech],
      logs: string[] = [];
    for (const command of ["plan", "deploy"]) {
      await inspectPrivateFiles(cwd, secrets);
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      insist(remaining > 0, "community_execution_window_expired", 409);
      logs.push(
        await runWithDiagnostics(
          "/usr/bin/timeout",
          [
            "--signal=TERM",
            "--kill-after=15s",
            `${remaining}s`,
            join(communityDependencyModules, ".bin/alchemy"),
            command,
            "--stage",
            "setup",
            "--no-input",
            ...(command === "deploy" ? ["--yes"] : []),
          ],
          { cwd, env, directory, password, phase: `application-${command}` },
        ),
      );
      await inspectPrivateFiles(cwd, secrets);
    }
    const response = await fetch(profile.origin + "/health", {
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      }),
      status = object(await response.json());
    insist(
      response.ok &&
        status.profileHash === profileHash &&
        status.planId === profile.planId &&
        status.signIn === "available" &&
        status.creatorConnection === "available",
      "community_application_health_unqualified",
      503,
    );
    const after = await inventory();
    const consumer = await qualifyCommunityConsumer(
      directory,
      password,
      cloudEnv,
      true,
    );
    await finishReviewedUpdate(
      directory,
      { profile, profileHash },
      {
        schema: "pirate.community-application-release/1",
        profileHash,
        before,
        after,
        logs,
        consumer,
        health: status,
      },
    );
    console.log(
      JSON.stringify(
        {
          profileHash,
          before,
          after,
          health: status,
          privateState: "encrypted successor; original wizard state preserved",
        },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    insist(
      (await readFile(lockPath, "utf8")) === identity,
      "community_execution_lock_changed",
      409,
    );
    await unlink(lockPath);
  }
}
main().catch((error) => {
  if (process.env.PIRATE_RELEASE_DEBUG === "1" && error instanceof Error)
    console.error(JSON.stringify({ type: error.name, frames: error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 6) }));
  console.error(
    error instanceof CommunityError
      ? error.code
      : error instanceof DeploymentFailure
        ? error.message
        : "community_application_release_failed; preserve state and reconcile",
  );
  process.exitCode = 1;
});
