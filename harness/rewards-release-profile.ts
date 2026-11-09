// Public configuration only. Reading or validating this input never activates rewards.
import { open } from "node:fs/promises";
import {
  canonical,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import { rewardProfile } from "../packages/rewards/validation.ts";
import { isRehearsalRollover } from "../packages/rewards/rehearsal.ts";
import { resultSource } from "../services/reward-sources.ts";
import type { RewardsProfile } from "../packages/rewards/contracts.ts";
import type { RewardResultSource } from "../services/reward-sources.ts";
import { assertStudyApplicationUpgrade } from "./study-application-upgrade.ts";

export interface RewardsReleaseSelection {
  schema: "pirate.rewards-release-selection/1";
  profile: RewardsProfile;
  source: RewardResultSource;
}
export function rewardsReleaseSelection(
  value: unknown,
): RewardsReleaseSelection {
  const p = object(value);
  exact(p, ["schema", "profile", "source"]);
  insist(
    p.schema === "pirate.rewards-release-selection/1",
    "reward_release_schema_invalid",
    409,
  );
  const profile = rewardProfile(JSON.stringify(p.profile));
  insist(
    profile.mode === "live-testnet" &&
      profile.operatorWallet === profile.payoutWallet,
    "reward_release_dedicated_signer_required",
    409,
  );
  const source = resultSource(JSON.stringify(p.source), profile);
  insist(
    canonical(p.profile) === canonical(profile) &&
      canonical(p.source) === canonical(source),
    "reward_release_noncanonical",
    409,
  );
  return { schema: "pirate.rewards-release-selection/1", profile, source };
}
export async function readRewardsReleaseSelection(path: string) {
  const file = await open(path, "r"),
    raw = Buffer.alloc(65537);
  let size = 0;
  try {
    while (size < raw.length) {
      const { bytesRead } = await file.read(raw, size, raw.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } finally {
    await file.close();
  }
  insist(size <= 65536, "reward_release_profile_too_large", 409);
  return rewardsReleaseSelection(
    JSON.parse(raw.subarray(0, size).toString("utf8")),
  );
}
/** A distinct successor gate. The existing Study-only migration/intent gate is unchanged. */
export function assertRewardsApplicationUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const rewards = rewardsReleaseSelection(next.rewards),
    learning = object(next.learning);
  insist(
    object(previous.learning).studyContract &&
      rewards.source.contract === learning.studyContract &&
      rewards.source.codeHash === learning.studyCodeHash,
    "reward_release_study_source_changed",
    409,
  );
  if (previous.rewards && canonical(previous.rewards) !== canonical(rewards)) {
    // The only accepted change is one reviewed rehearsal rollover: same source,
    // same program, the current rehearsal retired with its terms intact.
    const prior = rewardsReleaseSelection(previous.rewards);
    insist(
      canonical(prior.source) === canonical(rewards.source) &&
        isRehearsalRollover(prior.profile, rewards.profile),
      "reward_release_program_changed",
      409,
    );
  }
  const strip = (p: Record<string, unknown>) => {
    const { rewards: _, ...rest } = p;
    return {
      ...rest,
      migrations: (p.migrations as string[]).filter(
        (m) => m !== "0011_manual_rewards.sql",
      ),
    };
  };
  insist(
    Array.isArray(previous.migrations) &&
      Array.isArray(next.migrations) &&
      new Set(next.migrations).size === next.migrations.length &&
      (previous.rewards
        ? previous.migrations.at(-1) === "0011_manual_rewards.sql"
        : !previous.migrations.includes("0011_manual_rewards.sql")) &&
      canonical(next.migrations) ===
        canonical(
          previous.rewards
            ? previous.migrations
            : [...previous.migrations, "0011_manual_rewards.sql"],
        ),
    "reward_release_migrations_changed",
    409,
  );
  assertStudyApplicationUpgrade(strip(previous), strip(next));
}
