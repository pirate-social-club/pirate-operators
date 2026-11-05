import { access, copyFile, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import { fileDigest } from "./creator-state.ts";
import { unseal } from "../apps/creator-spike/infra/protected-data.ts";
import { creatorRemoteModules } from "./creator-inventory.ts";
import { saveConfigurationState } from "./megaeth/configuration-state.ts";

export interface CreatorRecoveryProfile extends Record<string, unknown> {
  predecessorState: Record<string, string>;
  predecessorModules: Record<string, string>;
  restoredStateRecovery: {
    previousPlanPath: string;
    previousProfileHash: string;
    expectedExecutionFileSha256: string;
  };
}
async function absent(path: string) {
  return access(path).then(
    () => false,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    },
  );
}
/** Local handoff only when restored state is still byte-for-byte the original
 * and no Alchemy phase ever started. Never adopts an uncertain remote update. */
export async function adoptCreatorProfile(
  directory: string,
  planned: { profile: CreatorRecoveryProfile; profileHash: string },
  password: string,
  token: string,
  readModules = creatorRemoteModules,
) {
  const policy = planned.profile.restoredStateRecovery,
    previous = object(
      JSON.parse(await readFile(policy.previousPlanPath, "utf8")),
    );
  insist(
    previous.profileHash === policy.previousProfileHash &&
      hashJson(previous.profile) === policy.previousProfileHash &&
      hashJson(planned.profile) === planned.profileHash,
    "creator_recovery_plan_changed",
    409,
  );
  const intent = (value: unknown) => {
    const { sourceHashes, restoredStateRecovery, ...rest } = object(value);
    return rest;
  };
  insist(
    canonical(intent(previous.profile)) === canonical(intent(planned.profile)),
    "creator_recovery_changes_intent",
    409,
  );
  const original = await readFile(join(directory, "execution.json"), "utf8"),
    record = object(JSON.parse(original));
  insist(
    fileDigest(original) === policy.expectedExecutionFileSha256 &&
      record.profileHash === policy.previousProfileHash,
    "creator_recovery_execution_changed",
    409,
  );
  insist(
    (await absent(join(directory, "diagnostics"))) &&
      (await absent(join(directory, "deployment-result.json"))),
    "creator_recovery_external_phase_started",
    409,
  );
  for (const [relative, digest] of Object.entries(
    planned.profile.predecessorState,
  )) {
    insist(
      relative.startsWith("pirate-creator-wallet-testnet/testnet/") &&
        /^\w+\.json$/.test(
          relative.slice("pirate-creator-wallet-testnet/testnet/".length),
        ),
      "invalid_creator_state_path",
      409,
    );
    const contents = unseal(
      await readFile(
        join(directory, "deployment/infra/.alchemy/state", relative),
        "utf8",
      ),
      password,
      `alchemy-state:${relative}`,
    );
    insist(
      fileDigest(contents) === digest,
      "creator_recovery_state_changed",
      409,
    );
  }
  for (const name of ["pirate-wallet-test", "pirate-creator-spike"])
    insist(
      canonical(await readModules(token, name)) ===
        canonical(planned.profile.predecessorModules),
      "creator_recovery_live_source_changed",
      409,
    );
  const backup = join(directory, "execution-before-scan-update.json");
  try {
    await copyFile(
      join(directory, "execution.json"),
      backup,
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    insist(
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await readFile(backup, "utf8")) === original,
      "creator_recovery_backup_changed",
      409,
    );
  }
  for (const path of [backup, directory]) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await saveConfigurationState(directory, "execution.json", {
    profileHash: planned.profileHash,
    previousProfileHash: policy.previousProfileHash,
    originalExecutionSha256: fileDigest(original),
    at: new Date().toISOString(),
  });
}
