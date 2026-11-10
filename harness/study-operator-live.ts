// Live adapter proposal. Module import performs no credential, network or write operation.
import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import {
  hashJson,
  insist,
  object,
  canonical,
} from "../packages/community/common.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { observeStudyRelease } from "./study-release-observation.ts";
import { observeLearningV4Release } from "./learning-v4-release-observation.ts";
import { privateJson, digest, durableJson } from "./private-json.ts";
import { retainedLearningOperator } from "./study-release-profile.ts";
import {
  prepareOperatorPackage,
  assertOperatorPackage,
} from "./study-operator-package.ts";
import {
  privateBytes,
  observeOperatorCloud,
  authenticateOperatorFiles,
} from "./study-operator-readonly-adapter.ts";
import {
  qualifyOperatorRuntime,
  counterEvidence,
} from "./study-operator-runtime-admission.ts";
import {
  operatorScope,
  readAdmission,
  readCustody,
  readPlanReview,
  preserveOperator,
  verifyOperatorBackup,
  changeExecution,
  acquireOperatorLock,
  releaseDirectory,
  operatorBase,
} from "./study-operator-private.ts";
import {
  writeOperatorPackage,
  deployOperatorOnce,
  assertDispatchedPackage,
  assertOperatorChildEnvironment,
} from "./study-operator-execution.ts";
import {
  operatorProfile,
  type OperatorProfile,
} from "./study-operator-profile.ts";
import { assertOperatorModuleClosure } from "./study-operator-module-closure.ts";
import type {
  OperatorRunnerPorts,
  LiveOperator,
  ExistingExecution,
} from "./study-operator-runner.ts";
export const managedOperatorReferences = {
  state: {
    projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
    environment: "staging",
    path: "/communities/first-song-20261105-runner",
    key: "PIRATE_WIZARD_STATE_PASSWORD",
  },
  speech: {
    projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
    environment: "staging",
    path: "/services/api-next",
    key: "ELEVENLABS_API_KEY",
  },
} as const;
interface RuntimeSecrets {
  password: string;
  speech: string;
  operatorKey: `0x${string}`;
}
export function operatorEnvironment(
  profile: OperatorProfile,
  safe: NodeJS.ProcessEnv,
  token: string,
  secrets: RuntimeSecrets,
  activationAccount?: string,
): NodeJS.ProcessEnv {
  profile = operatorProfile(profile);
  insist(
    !activationAccount || /^0x[0-9a-f]{40}$/.test(activationAccount),
    "study_operator_activation_environment_invalid",
    409,
  );
  if (profile.activationAccount)
    insist(
      activationAccount === profile.activationAccount.previous ||
        activationAccount === profile.activationAccount.next,
      "study_operator_activation_predecessor_changed",
      409,
    );
  const env = {
    PATH: safe.PATH,
    HOME: safe.HOME,
    TMPDIR: safe.TMPDIR,
    CI: "true",
    NO_COLOR: "1",
    ALCHEMY_TELEMETRY_DISABLED: "1",
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: profile.worker.accountId,
    PIRATE_WIZARD_STATE_PASSWORD: secrets.password,
    LEARNING_COMMUNITY_ID: profile.selection.communityId,
    LEARNING_PROFILE: "pirate-learning-testnet-v3",
    LEARNING_RESULTS_CONTRACT: profile.selection.resultsV2.contract,
    LEARNING_RESULTS_V3_CONTRACT: profile.selection.resultsV3.contract,
    ...(profile.learningV4
      ? { LEARNING_RESULTS_V4_CONTRACT: profile.learningV4.contract }
      : {}),
    LEARNING_GRADER_ADDRESS: retainedLearningOperator.publisher,
    LEARNING_ISSUER_ADDRESS: getAddress(retainedLearningOperator.issuer),
    LEARNING_OPERATOR_PRIVATE_KEY: secrets.operatorKey,
    LEARNING_ELEVENLABS_API_KEY: secrets.speech,
    LEARNING_SPONSOR_CAP_WEI: profile.retained.limits.sponsorCapWei,
    LEARNING_GAS_PRICE_WEI: profile.retained.limits.gasPriceWei,
    LEARNING_GAS_LIMIT: profile.retained.limits.gasLimit,
    LEARNING_DATA_FEE_WEI: profile.retained.limits.dataFeeWei,
    LEARNING_SPEECH_DAILY_LIMIT: "0",
    LEARNING_QUOTE_VALID_FROM: String(profile.retained.quoteValidFrom),
    LEARNING_QUOTE_VALID_UNTIL: String(profile.retained.quoteValidUntil),
    ...(profile.activationAccount || activationAccount
      ? {
          LEARNING_APPROVED_ACTIVATION_ACCOUNT:
            profile.activationAccount?.next ?? activationAccount,
        }
      : {}),
  };
  assertOperatorChildEnvironment(profile, env, secrets.password);
  return env;
}
export function makeLiveOperatorPorts(
  sourceRoot = process.cwd(),
): OperatorRunnerPorts {
  let prepared: Awaited<ReturnType<typeof prepareOperatorPackage>> | undefined,
    password: string | undefined,
    before: Awaited<ReturnType<typeof qualifyOperatorRuntime>> | undefined,
    activationAccount: string | undefined,
    afterProofSha256: string | undefined;
  const client = () => megaethReadClient();
  const get = async (
    reference:
      | typeof managedOperatorReferences.state
      | typeof managedOperatorReferences.speech,
  ) => {
    const { infisicalAuth } = await import(
      "../apps/community-wizard/server/infisical-auth.ts"
    );
    const sdk = await infisicalAuth().client();
    const result = await sdk.secrets().getSecret({
      projectId: reference.projectId,
      environment: reference.environment,
      secretPath: reference.path,
      secretName: reference.key,
      includeImports: false,
      expandSecretReferences: false,
    });
    insist(result.secretValue, "study_operator_managed_secret_missing", 503);
    return result.secretValue;
  };
  const cloudValue = (cloud: unknown) => {
    const value = object(cloud);
    insist(
      typeof value.token === "string" &&
        value.accountId === "08a4c22cf52e2ecae883e36f80a33f4a",
      "study_operator_cloud_context_changed",
      409,
    );
    return value as {
      token: string;
      accountId: string;
      safe: NodeJS.ProcessEnv;
    };
  };
  return {
    async verifySourceAndArtifact(value) {
      const profile = operatorProfile(value);
      prepared = await prepareOperatorPackage(sourceRoot);
      assertOperatorPackage(profile, prepared);
    },
    async observeContracts(profile) {
      await observeStudyRelease(client(), profile.selection);
      if (profile.learningV4)
        await observeLearningV4Release(client(), profile.learningV4);
    },
    acquireLock: acquireOperatorLock,
    async loadCloudCredential(profile) {
      const { cfLoginToken, operatorEnvironment: cloudEnvironment } =
        await import("../apps/community-wizard/server/operator.ts");
      const safe = cloudEnvironment(process.env);
      const token = await cfLoginToken(
        {
          directory: join(
            homedir(),
            ".local/state/pirate-first-song-managed-20261105",
          ),
          projectId: managedOperatorReferences.state.projectId,
          environment: "staging",
          secretPath: managedOperatorReferences.state.path,
          site: "https://app.infisical.com",
          profile: "",
          mode: "cf-login",
          cfProfile: "default",
          port: "8791",
          accountId: profile.worker.accountId,
          check: false,
        },
        safe,
      );
      return { token, accountId: profile.worker.accountId, safe };
    },
    async observeOperator(profile, cloud) {
      const c = cloudValue(cloud),
        observed = await observeOperatorCloud(
          profile,
          c.token,
          profile.execution.moduleName,
        );
      await readAdmission(profile);
      activationAccount = observed.activationAccount;
      return {
        workerTag: observed.workerTag,
        namespaces: observed.objects,
        moduleSha256: observed.moduleSha256,
        publicSettingsInvariantSha256: observed.publicSettingsInvariantSha256,
        runtimeEvidenceSha256: profile.retained.runtimeEvidenceSha256,
      } as LiveOperator;
    },
    async authenticateRetainedState(profile) {
      password ??= await get(managedOperatorReferences.state);
      await authenticateOperatorFiles(profile, password);
    },
    async qualifyCustodyAndRuntime(profile, cloud) {
      before = await qualifyOperatorRuntime(
        profile,
        cloudValue(cloud).token,
        client(),
      );
    },
    async existingExecution(hash) {
      const value = await privateJson(
        join(releaseDirectory(hash), "execution.json"),
      );
      if (!value) return "none";
      insist(
        value.schema === "pirate.study-operator-execution/1" &&
          value.profileHash === hash &&
          ["prepared", "dispatched", "unknown", "complete"].includes(
            String(value.state),
          ),
        "study_operator_execution_record_changed",
        409,
      );
      return value.state as ExistingExecution;
    },
    async preservePredecessor(profile, hash) {
      await preserveOperator(profile, hash);
    },
    recordPrepared: (hash) => changeExecution(hash, "prepared"),
    recordDispatched: (hash) => changeExecution(hash, "dispatched"),
    recordUnknown: (hash) => changeExecution(hash, "unknown"),
    recordComplete: async (hash) => {
      insist(afterProofSha256, "study_operator_successor_proof_missing", 409);
      await changeExecution(hash, "complete", { afterProofSha256 });
    },
    async loadRuntimeSecrets(profile) {
      insist(password, "study_operator_state_not_authenticated", 409);
      if (profile.execution.reviewedPlanPath) {
        const review = await readPlanReview(profile);
        insist(
          prepared &&
            canonical(review.receipt.packageFiles) ===
              canonical(
                Object.fromEntries(
                  Object.entries(prepared.files).map(([n, b]) => [
                    n,
                    digest(b),
                  ]),
                ),
              ),
          "study_operator_reviewed_package_changed",
          409,
        );
      }
      insist(prepared && before, "study_operator_preparation_missing", 409);
      // Materialize and qualify the exact upload closure before runtime key/speech loading.
      await writeOperatorPackage(
        profile,
        hashJson(profile),
        prepared,
        profile.execution.reviewedPlanPath ? "deploy" : "plan",
      );
      const path = join(
          homedir(),
          ".config/pirate-operators/megaeth-testnet/keys.json",
        ),
        bytes = await privateBytes(path);
      insist(
        digest(bytes) === profile.execution.operatorKeyFileSha256,
        "study_operator_key_file_changed",
        409,
      );
      const file = object(JSON.parse(bytes.toString())),
        keys = object(file.keys);
      insist(
        file.chainId === 6343 &&
          typeof keys.operator === "string" &&
          /^0x[0-9a-f]{64}$/i.test(keys.operator) &&
          privateKeyToAccount(
            keys.operator as `0x${string}`,
          ).address.toLowerCase() === retainedLearningOperator.publisher &&
          typeof keys.communityAdmin === "string" &&
          privateKeyToAccount(
            keys.communityAdmin as `0x${string}`,
          ).address.toLowerCase() === retainedLearningOperator.issuer,
        "study_operator_managed_signer_changed",
        409,
      );
      return {
        password,
        speech: await get(managedOperatorReferences.speech),
        operatorKey: keys.operator,
      } as RuntimeSecrets;
    },
    async applyOnce(profile, hash, cloud, unknown) {
      insist(prepared && before, "study_operator_preparation_missing", 409);
      assertOperatorPackage(profile, prepared);
      const c = cloudValue(cloud),
        secrets = unknown as RuntimeSecrets;
      await verifyOperatorBackup(profile, hash);
      await writeOperatorPackage(profile, hash, prepared);
      const env = operatorEnvironment(
        profile,
        c.safe,
        c.token,
        secrets,
        activationAccount,
      );
      // This is the only real child executor import; the runner has durably
      // recorded dispatched and completed all public/private evidence gates.
      const { spawn } = await import("node:child_process");
      await deployOperatorOnce(
        profile,
        hash,
        env,
        secrets.password,
        [c.token, secrets.password, secrets.speech, secrets.operatorKey],
        Date.now(),
        {
          spawn,
          assertDispatch: () =>
            assertDispatchedPackage(profile, hash, prepared!),
        },
      );
    },
    async planOnly(profile, hash, cloud, unknown) {
      insist(prepared && before, "study_operator_preparation_missing", 409);
      assertOperatorPackage(profile, prepared);
      const c = cloudValue(cloud),
        secrets = unknown as RuntimeSecrets;
      await verifyOperatorBackup(profile, hash);
      await writeOperatorPackage(profile, hash, prepared, "plan");
      const env = operatorEnvironment(
        profile,
        c.safe,
        c.token,
        secrets,
        activationAccount,
      );
      const { spawn } = await import("node:child_process");
      const result = await deployOperatorOnce(
        profile,
        hash,
        env,
        secrets.password,
        [c.token, secrets.password, secrets.speech, secrets.operatorKey],
        Date.now(),
        {
          spawn,
          operation: "plan",
          assertDispatch: () =>
            assertDispatchedPackage(profile, hash, prepared!, "prepared"),
        },
      );
      insist(
        typeof result.planOutput === "string" && result.command,
        "study_operator_cloud_plan_output_missing",
        409,
      );
      const rawPlanPath = join(releaseDirectory(hash), "cloud-plan-output.txt");
      const handle = await open(rawPlanPath, "wx", 0o600);
      try {
        await handle.writeFile(result.planOutput);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const receiptPath = join(
        releaseDirectory(hash),
        "cloud-plan-receipt.json",
      );
      await durableJson(receiptPath, {
        schema: "pirate.study-operator-cloud-plan/1",
        profileHash: hash,
        scopeHash: operatorScope(profile),
        command: result.command,
        rawPlanPath,
        rawPlanSha256: digest(result.planOutput),
        packageFiles: Object.fromEntries(
          Object.entries(prepared.files).map(([n, b]) => [n, digest(b)]),
        ),
        moduleClosure: await assertOperatorModuleClosure(
          profile,
          join(releaseDirectory(hash), "package"),
          prepared,
        ),
        diagnosticId: result.logId,
      });
      return {
        receiptPath,
        receiptSha256: digest(await privateBytes(receiptPath)),
        rawPlanPath,
        rawPlanSha256: digest(result.planOutput),
      };
    },
    async verifyPreservedSuccessor(profile, hash, cloud) {
      await verifyOperatorBackup(profile, hash);
      const c = cloudValue(cloud),
        observed = await observeOperatorCloud(
          profile,
          c.token,
          profile.execution.moduleName,
        );
      insist(
        observed.moduleSha256 === profile.artifact.sha256,
        "study_operator_successor_module_missing",
        409,
      );
      await readCustody(profile, Date.now(), true);
      const execution = await privateJson(
        join(releaseDirectory(hash), "execution.json"),
      );
      insist(execution, "study_operator_execution_record_missing", 409);
      const original = await readAdmission(profile),
        baseline = await counterEvidence(profile, original.counterEvidence);
      if (baseline.mode === "reviewed-persistence-proof") {
        const current =
          execution.state === "complete"
            ? undefined
            : await qualifyOperatorRuntime(
                profile,
                c.token,
                client(),
                Date.now(),
                true,
              );
        const path = join(releaseDirectory(hash), "successor-observation.json");
        const saved = await privateJson(path);
        if (!saved) {
          const { durableJson } = await import("./private-json.ts");
          await durableJson(path, {
            schema: "pirate.study-operator-successor/1",
            profileHash: hash,
            scopeHash: operatorScope(profile),
            moduleSha256: observed.moduleSha256,
            workerTag: observed.workerTag,
            namespaces: observed.objects,
            preservationBasisHash: baseline.basisHash,
            liveCounterValuesObserved: false,
            opaqueJournals:
              "retained in the same namespace; values not observed",
            runtimeSummary: current
              ? {
                  operatorNonce: current.operatorNonce,
                  controllerNonce: current.controllerNonce,
                  wallets: current.wallets,
                }
              : null,
            observedAt: new Date().toISOString(),
          });
        }
        const proof = await privateJson(path);
        insist(
          proof &&
            proof.profileHash === hash &&
            proof.moduleSha256 === profile.artifact.sha256 &&
            proof.preservationBasisHash === baseline.basisHash &&
            proof.workerTag === profile.worker.tag &&
            canonical(proof.namespaces) === canonical(profile.objects),
          "study_operator_successor_observation_changed",
          409,
        );
        afterProofSha256 = digest(await privateBytes(path));
      } else {
        const path = join(releaseDirectory(hash), "after-runtime.json"),
          after = await privateJson(path);
        insist(
          after &&
            after.schema === "pirate.study-operator-after-runtime/1" &&
            after.scopeHash === operatorScope(profile) &&
            Date.parse(String(after.observedAt)) >=
              Date.parse(String(execution.dispatchedAt)) &&
            Date.parse(String(after.observedAt)) <= Date.now(),
          "study_operator_after_counter_capture_missing_or_stale",
          409,
        );
        if (execution.state !== "complete")
          await qualifyOperatorRuntime(
            profile,
            c.token,
            client(),
            Date.now(),
            true,
          );
        const counters = await counterEvidence(
          profile,
          after.counterEvidence,
          "after",
        );
        insist(
          counters.mode === "authenticated-export" &&
            counters.operatorRecordsSha256 === baseline.operatorRecordsSha256 &&
            counters.speechDaysSha256 === baseline.speechDaysSha256 &&
            counters.ledgerSha256 === baseline.ledgerSha256,
          "study_operator_counters_not_preserved",
          409,
        );
        afterProofSha256 = digest(await privateBytes(path));
      }
      if (execution.state === "complete")
        insist(
          execution.afterProofSha256 === afterProofSha256,
          "study_operator_completed_proof_changed",
          409,
        );
    },
    now: Date.now,
  };
}
