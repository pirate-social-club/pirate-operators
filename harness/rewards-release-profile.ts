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
import {
  MAX_RESULT_SUCCESSORS,
  resultSource,
  resultSuccessor,
  rewardResultSources,
} from "../services/reward-sources.ts";
import type { RewardsProfile } from "../packages/rewards/contracts.ts";
import type {
  RewardResultSource,
  RewardResultSuccessor,
} from "../services/reward-sources.ts";
import { assertStudyApplicationUpgrade } from "./study-application-upgrade.ts";

export interface RewardsReleaseSelection {
  schema: "pirate.rewards-release-selection/1";
  profile: RewardsProfile;
  source: RewardResultSource;
  /**
   * Result sources appended after the original, oldest first. Absent until
   * the first one; a release may append one and never edits or removes any.
   */
  successors?: RewardResultSuccessor[];
}
export function rewardsReleaseSelection(
  value: unknown,
): RewardsReleaseSelection {
  const p = object(value);
  exact(
    p,
    p.successors === undefined
      ? ["schema", "profile", "source"]
      : ["schema", "profile", "source", "successors"],
  );
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
  const successors =
    p.successors === undefined
      ? undefined
      : (() => {
          insist(
            Array.isArray(p.successors) &&
              p.successors.length > 0 &&
              p.successors.length <= MAX_RESULT_SUCCESSORS,
            "reward_release_successors_invalid",
            409,
          );
          return p.successors.map(resultSuccessor);
        })();
  if (successors) {
    // Distinct contracts, and the reader accepts the list as configured.
    rewardResultSources(source, JSON.stringify(successors));
    // Every successor is graded by the original source's publisher, whose
    // grader roles the release observes on chain.
    insist(
      successors.every((s) => s.grader === source.grader),
      "reward_release_successor_grader_changed",
      409,
    );
  }
  insist(
    canonical(p.profile) === canonical(profile) &&
      canonical(p.source) === canonical(source) &&
      (successors === undefined ||
        canonical(p.successors) === canonical(successors)),
    "reward_release_noncanonical",
    409,
  );
  return {
    schema: "pirate.rewards-release-selection/1",
    profile,
    source,
    ...(successors ? { successors } : {}),
  };
}
/**
 * A rewards selection and a LearningResultsV4 selection travel together: a V4
 * release must append the V4 contract as a rewards source, and a V4 source
 * exists only beside the V4 selection it names.
 */
export function assertRewardsFollowLearningV4(
  rewards: RewardsReleaseSelection | undefined,
  learningV4: { contract: string; codeHash: string } | undefined,
) {
  if (!rewards) return;
  const v4 = (rewards.successors ?? []).filter((s) => s.version === 4).at(-1);
  // The latest V4 source is the selected deployment; earlier ones stay as
  // appended, and their offers keep reading them.
  insist(
    learningV4
      ? !!v4 &&
          v4.contract === learningV4.contract.toLowerCase() &&
          v4.codeHash === learningV4.codeHash.toLowerCase()
      : !v4,
    "reward_release_v4_source_mismatch",
    409,
  );
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
  const prior = previous.rewards
    ? rewardsReleaseSelection(previous.rewards)
    : undefined;
  // Result sources are append-only: earlier successors stay byte-identical
  // and in order, and one release appends at most one.
  const before = prior?.successors ?? [],
    after = rewards.successors ?? [];
  insist(
    after.length - before.length <= 1 &&
      before.length <= after.length &&
      canonical(after.slice(0, before.length)) === canonical(before) &&
      (prior || after.length === 0),
    "reward_release_successors_changed",
    409,
  );
  const { successors: _a, ...nextTerms } = rewards;
  if (prior) {
    const { successors: _b, ...priorTerms } = prior;
    if (canonical(priorTerms) !== canonical(nextTerms))
      // Otherwise the only accepted change is one reviewed rehearsal rollover:
      // same source, same program, the current rehearsal retired intact.
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
