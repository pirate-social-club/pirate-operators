// Manual bounded staging workflow. Default is a source-bound plan; execution
// requires its reviewed hash. Never prints provider values or child output.
import { readFile, writeFile, open, unlink, lstat } from "node:fs/promises";
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
import {
  runWithDiagnostics,
  DeploymentFailure,
} from "../apps/community-wizard/server/diagnostics.ts";
import { inspectPrivateFiles } from "../apps/community-wizard/server/state-inspection.ts";
import { privateDirectory } from "../apps/community-wizard/server/state.ts";
import { CommunityError, insist } from "../packages/community/common.ts";
import { managedInventory } from "./managed-inventory.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";
import { saveConfigurationState } from "./megaeth/configuration-state.ts";
import { privateJson } from "./private-json.ts";
import {
  qualifyManagedUpdate,
  preserveManagedDeployment,
} from "./managed-update.ts";
import {
  managedPackage,
  managedPrefix,
  managedOrigin,
  writeManagedPackage,
} from "./managed-package.ts";

const base = join(homedir(), ".local/state/pirate-first-song-managed-20261105"),
  directory = join(base, "managed-service");
async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean" },
      inventory: { type: "boolean" },
      update: { type: "boolean" },
      preflight: { type: "boolean" },
      "expected-profile": { type: "string" },
      "write-plan": { type: "boolean" },
    },
  });
  const packaged = await managedPackage(),
    { profile, profileHash } = packaged;
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.moderation-plan.json",
      JSON.stringify({ profileHash, profile }, null, 2) + "\n",
    );
  if (!values.execute && !values.inventory && !values.preflight) {
    console.log(JSON.stringify({ profileHash, profile }, null, 2));
    return;
  }
  if (values.execute)
    insist(
      values["expected-profile"] === profileHash,
      "managed_profile_not_reviewed",
    );
  const safe = operatorEnvironment(process.env);
  const options: OperatorOptions = {
    directory: base,
    projectId: profile.stateProtection.projectId,
    environment: "staging",
    secretPath: profile.stateProtection.path,
    site: "https://app.infisical.com",
    profile: "",
    mode: "cf-login",
    cfProfile: "default",
    port: "8791",
    accountId: profile.accountId,
    check: false,
  };
  const cloudflare = await cfLoginToken(options, safe);
  const cloudEnv = {
    ...safe,
    CLOUDFLARE_ACCOUNT_ID: profile.accountId,
    CLOUDFLARE_API_TOKEN: cloudflare,
  };
  const before = await managedInventory(cloudEnv, managedPrefix);
  if (!values.execute && !values.preflight) {
    console.log(JSON.stringify({ profileHash, inventory: before }, null, 2));
    return;
  }
  insist(values.update, "managed_update_requires_explicit_flag", 409);
  insist(
    before.resources.every((r) => r.present),
    "managed_owned_resources_missing",
    409,
  );
  await privateDirectory(directory);
  const lockPath = join(directory, "execution.lock"),
    lock = await open(lockPath, "wx", 0o600);
  const identity = JSON.stringify({
    pid: process.pid,
    profileHash,
    startedAt: new Date().toISOString(),
  });
  await lock.writeFile(identity);
  await lock.sync();
  try {
    const deadline = Date.now() + profile.bounds.executionSeconds * 1000;
    const sdk = await infisicalAuth().client(),
      credentials = profile.providerCredentials;
    const get = async (
      projectId: string,
      secretPath: string,
      secretName: string,
    ) => {
      const result = await sdk.secrets().getSecret({
        projectId,
        environment: "staging",
        secretPath,
        secretName,
        includeImports: false,
        expandSecretReferences: false,
      });
      insist(
        result.secretValue && result.secretValue.length > 0,
        "managed_credential_empty",
        503,
      );
      return result.secretValue;
    };
    const password = await get(
      profile.stateProtection.projectId,
      profile.stateProtection.path,
      "PIRATE_WIZARD_STATE_PASSWORD",
    );
    await qualifyManagedUpdate(directory, profile, before, password, cloudEnv);
    if (!values.execute) {
      console.log(
        JSON.stringify({
          profileHash,
          inventory: before,
          ownership: "verified encrypted state",
          idle: true,
        }),
      );
      return;
    }
    const completed = await privateJson(
      join(directory, "deployment-result.json"),
    );
    if (completed?.profileHash === profileHash) {
      const live = await fetch(managedOrigin + "/health", {
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        }),
        health = (await live.json()) as { profileHash: string; status: string },
        modules = await fetchWorkerModuleDigests(
          cloudflare,
          profile.accountId,
          managedPrefix,
          ["worker.mjs"],
        );
      insist(
        live.ok &&
          health.profileHash === profileHash &&
          health.status === "available" &&
          Object.keys(modules).length === 1 &&
          Object.values(modules)[0] === profile.bundleSha256,
        "managed_completed_release_not_live",
        503,
      );
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
    const file = join(
        homedir(),
        ".config/pirate-operators/megaeth-testnet/keys.json",
      ),
      metadata = await lstat(file);
    insist(
      metadata.isFile() &&
        !(metadata.mode & 0o077) &&
        metadata.uid === process.getuid!(),
      "managed_signer_file_not_private",
    );
    const keys = JSON.parse(await readFile(file, "utf8"));
    insist(
      keys.chainId === 6343 &&
        privateKeyToAccount(keys.keys.purchaseSigner).address.toLowerCase() ===
          profile.moderationSigner,
      "managed_signer_identity_mismatch",
    );
    const secrets: Record<string, string> = {
      MODERATION_SIGNER_PRIVATE_KEY: keys.keys.purchaseSigner,
    };
    for (const name of [
      "ACRCLOUD_ACCESS_KEY",
      "ACRCLOUD_ACCESS_SECRET",
      "OPENAI_API_KEY",
    ])
      secrets[name] = await get(
        credentials.projectId,
        credentials.sourcePath,
        name,
      );
    const parent = "/services",
      folderName = managedPrefix;
    const listFolders = () =>
      sdk.folders().listFolders({
        projectId: credentials.projectId,
        environment: "staging",
        path: parent,
        recursive: false,
      });
    if (!(await listFolders()).some((f) => f.name === folderName)) {
      try {
        await sdk.folders().create({
          projectId: credentials.projectId,
          environment: "staging",
          path: parent,
          name: folderName,
        });
      } catch {
        insist(
          (await listFolders()).some((f) => f.name === folderName),
          "managed_credential_folder_unconfirmed",
          503,
        );
      }
    }
    const names = await sdk.secrets().listSecrets({
      projectId: credentials.projectId,
      environment: "staging",
      secretPath: credentials.targetPath,
      viewSecretValue: false,
      recursive: false,
      includeImports: false,
      expandSecretReferences: false,
    });
    for (const [name, secretValue] of Object.entries(secrets)) {
      if (names.secrets.some((s) => s.secretKey === name))
        insist(
          (await get(credentials.projectId, credentials.targetPath, name)) ===
            secretValue,
          "managed_credential_binding_changed",
          409,
        );
      else {
        try {
          await sdk.secrets().createSecret(name, {
            projectId: credentials.projectId,
            environment: "staging",
            secretPath: credentials.targetPath,
            secretValue,
          });
        } catch {
          insist(
            (await get(credentials.projectId, credentials.targetPath, name)) ===
              secretValue,
            "managed_credential_binding_unconfirmed",
            503,
          );
        }
      }
      insist(
        (await get(credentials.projectId, credentials.targetPath, name)) ===
          secretValue,
        "managed_credential_binding_unconfirmed",
        503,
      );
    }
    await preserveManagedDeployment(directory, profileHash);
    const cwd = await writeManagedPackage(directory, packaged.bytes);
    const env = {
      ...cloudEnv,
      PIRATE_WIZARD_STATE_PASSWORD: password,
      ...secrets,
      SERVICE_ORIGIN: managedOrigin,
      SERVICE_PROFILE_HASH: profileHash,
      PAIRINGS_JSON: JSON.stringify(profile.pairings),
      DIRECTORY_PROFILES_JSON: JSON.stringify(profile.directoryProfiles),
      SERVICE_BUDGET_PERIOD: profile.serviceBudgetPeriod,
      SERVICE_REQUEST_CAP: String(profile.serviceRequestCap),
      ACRCLOUD_HOST: profile.acrHost,
    };
    const secretValues = [password, cloudflare, ...Object.values(secrets)];
    const logs: string[] = [];
    for (const command of ["plan", "deploy"]) {
      await inspectPrivateFiles(cwd, secretValues);
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      insist(remaining > 0, "managed_execution_window_expired", 409);
      logs.push(
        await runWithDiagnostics(
          "/usr/bin/timeout",
          [
            "--signal=TERM",
            "--kill-after=15s",
            `${remaining}s`,
            resolve("apps/managed-moderation/node_modules/.bin/alchemy"),
            command,
            "--stage",
            "managed",
            "--no-input",
            ...(command === "deploy" ? ["--yes"] : []),
          ],
          { cwd, env, directory, password, phase: `managed-${command}` },
        ),
      );
      await inspectPrivateFiles(cwd, secretValues);
    }
    const health = await fetch(managedOrigin + "/health", {
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    const status = (await health.json()) as {
      profileHash: string;
      status: string;
    };
    insist(
      health.ok &&
        status.profileHash === profileHash &&
        status.status === "available",
      "managed_health_not_qualified",
      503,
    );
    const after = await managedInventory(cloudEnv, managedPrefix);
    const modules = await fetchWorkerModuleDigests(
      cloudflare,
      profile.accountId,
      managedPrefix,
      ["worker.mjs"],
    );
    insist(
      Object.keys(modules).length === 1 &&
        Object.values(modules)[0] === profile.bundleSha256,
      "managed_applied_source_unqualified",
      503,
    );
    insist(
      after.resources.every(
        (r, i) => r.present && r.id === before.resources[i]?.id,
      ),
      "managed_resource_identity_unconfirmed",
      503,
    );
    await saveConfigurationState(directory, "deployment-result.json", {
      profileHash,
      before,
      after,
      logs,
      status,
    });
    console.log(
      JSON.stringify(
        {
          profileHash,
          before,
          after,
          health: status,
          credentials: "existing scoped bindings confirmed",
          privateState: "encrypted scan passed",
        },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    insist(
      (await readFile(lockPath, "utf8")) === identity,
      "managed_lock_changed",
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
        : "managed_service_execution_failed; preserve private state and reconcile before retry",
  );
  process.exitCode = 1;
});
