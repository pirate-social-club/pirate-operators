// Public configuration only. Reading or validating this input never deploys
// the V4 contract, grants a grader role or changes the directory; release
// custody does those. V4 requires owner0012, authorization0013 and current
// authority0018; shared profile0019 remains in the selected package history.
import { open } from "node:fs/promises";
import {
  canonical,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { canonicalOriginV4 } from "../packages/protocol/learning-results-v4.ts";
import {
  LEARNING_AUTHORIZATION_MIGRATION,
  LEARNING_AUTHORITY_MIGRATION,
  REWARD_CLOSURE_MIGRATION,
  COMMUNITY_MEDIA_MIGRATION,
  DANCE_MIGRATION,
  DANCE_CANONICAL_MIGRATION,
} from "./package-migrations.ts";
import {
  assertPublishingApplicationUpgrade,
  COMMUNITY_PROFILE_MIGRATION,
} from "./publishing-release-profile.ts";

/** The reviewed LearningResultsV4 deployment a release binds for new work. */
export interface LearningV4ReleaseSelection {
  schema: "pirate.learning-v4-release-selection/1";
  chainId: 6343;
  contract: string;
  /** keccak256 of the deployed runtime code, checked before binding. */
  codeHash: string;
  /** The contract's controller, checked before binding. */
  controller: string;
  publicationPolicy: string;
  policyVersion: 4;
  /** The contract's communityOrigin, which its sign-in text names; the
   * application's own origin. */
  communityOrigin: string;
}
export function learningV4ReleaseSelection(
  value: unknown,
): LearningV4ReleaseSelection {
  const p = object(value);
  exact(p, [
    "schema",
    "chainId",
    "contract",
    "codeHash",
    "controller",
    "publicationPolicy",
    "policyVersion",
    "communityOrigin",
  ]);
  insist(
    p.schema === "pirate.learning-v4-release-selection/1" &&
      p.chainId === 6343 &&
      typeof p.contract === "string" &&
      /^0x[0-9a-f]{40}$/.test(p.contract) &&
      BigInt(p.contract) !== 0n &&
      typeof p.codeHash === "string" &&
      /^0x[0-9a-f]{64}$/.test(p.codeHash) &&
      BigInt(p.codeHash) !== 0n &&
      typeof p.controller === "string" &&
      /^0x[0-9a-f]{40}$/.test(p.controller) &&
      BigInt(p.controller) !== 0n &&
      // The drafted policy the contract's immutable publicationPolicy carries.
      p.publicationPolicy === learningV4PublicityPolicy &&
      p.policyVersion === 4 &&
      typeof p.communityOrigin === "string" &&
      // The constructor's rule, and a sign-in text must build for it: the
      // contract accepts some origins viem's SIWE builder refuses, and
      // communityOrigin is immutable.
      canonicalOriginV4(p.communityOrigin),
    "learning_v4_release_selection_invalid",
    409,
  );
  return {
    schema: "pirate.learning-v4-release-selection/1",
    chainId: 6343,
    contract: p.contract,
    codeHash: p.codeHash,
    controller: p.controller,
    publicationPolicy: p.publicationPolicy,
    policyVersion: 4,
    communityOrigin: p.communityOrigin,
  };
}

export async function readLearningV4ReleaseSelection(path: string) {
  const file = await open(path, "r"),
    raw = Buffer.alloc(16385);
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
  insist(size <= 16384, "learning_v4_release_profile_too_large", 409);
  return learningV4ReleaseSelection(
    JSON.parse(raw.subarray(0, size).toString("utf8")),
  );
}

/**
 * V4 successor of a deployed Study, rewards and owner publishing application.
 * It adds the reviewed V4 selection and its exact authorization/authority
 * schema, retaining shared profile19 and any previously selected features.
 * Historical13-only profiles still reconcile under their original contract.
 * Current packages carry13/18/19. A retained optional feature is never
 * activated, removed or rewritten by this gate. After checking this exact
 * schema transition, delegate unchanged financial/resource/identity intent to
 * the publishing, rewards and Study gates.
 */
export function assertLearningV4ApplicationUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const selection = learningV4ReleaseSelection(next.learningV4);
  insist(
    previous.ownerPublishing && next.ownerPublishing,
    "learning_v4_publishing_required",
    409,
  );
  const learning = object(next.learning);
  insist(
    selection.contract !== learning.contract &&
      selection.contract !== learning.studyContract,
    "learning_v4_contract_reused",
    409,
  );
  // The sign-in text names the contract's origin: it must be this application's.
  insist(
    selection.communityOrigin === next.origin,
    "learning_v4_origin_changed",
    409,
  );
  const migrations = (p: Record<string, unknown>) => {
    insist(
      Array.isArray(p.migrations) &&
        p.migrations.every((m) => typeof m === "string") &&
        new Set(p.migrations).size === p.migrations.length,
      "learning_v4_migrations_invalid",
      409,
    );
    return p.migrations as string[];
  };
  const before = migrations(previous),
    after = migrations(next);
  const retainedFeatures = [
    REWARD_CLOSURE_MIGRATION,
    COMMUNITY_MEDIA_MIGRATION,
    DANCE_MIGRATION,
    DANCE_CANONICAL_MIGRATION,
  ];
  const features = (names: string[]) =>
    names.filter((m) => retainedFeatures.includes(m));
  const dependencies = (names: string[]) =>
    (features(names).length === 0 ||
      names.includes(LEARNING_AUTHORIZATION_MIGRATION)) &&
    (!names.includes(DANCE_MIGRATION) ||
      (names.includes(REWARD_CLOSURE_MIGRATION) &&
        names.includes(COMMUNITY_MEDIA_MIGRATION))) &&
    (!names.includes(DANCE_CANONICAL_MIGRATION) ||
      names.includes(DANCE_MIGRATION));
  const additions: string[] = [];
  if (previous.learningV4) {
    insist(
      canonical(learningV4ReleaseSelection(previous.learningV4)) ===
        canonical(selection),
      "learning_v4_selection_changed",
      409,
    );
    insist(
      before.includes(LEARNING_AUTHORIZATION_MIGRATION),
      "learning_v4_migrations_changed",
      409,
    );
  } else {
    insist(
      !before.includes(LEARNING_AUTHORIZATION_MIGRATION) &&
        !before.includes(LEARNING_AUTHORITY_MIGRATION),
      "learning_v4_migrations_changed",
      409,
    );
    additions.push(LEARNING_AUTHORIZATION_MIGRATION);
  }
  // The current selector adds the authority/profile pair. Name/hash history
  // is preserved even when those ordinals precede an already-applied19.
  for (const migration of [
    LEARNING_AUTHORITY_MIGRATION,
    COMMUNITY_PROFILE_MIGRATION,
  ])
    if (!before.includes(migration) && after.includes(migration))
      additions.push(migration);
  insist(
    canonical(before) === canonical([...before].sort()) &&
      canonical(after) === canonical([...before, ...additions].sort()) &&
      canonical(features(after)) === canonical(features(before)) &&
      dependencies(before) &&
      dependencies(after) &&
      (!(
        after.includes(LEARNING_AUTHORITY_MIGRATION) ||
        after.includes(COMMUNITY_PROFILE_MIGRATION)
      ) ||
        (after.includes(LEARNING_AUTHORITY_MIGRATION) &&
          after.includes(COMMUNITY_PROFILE_MIGRATION))),
    "learning_v4_migrations_changed",
    409,
  );
  const strip = (p: Record<string, unknown>) => {
    const { learningV4: _, ...rest } = p;
    return {
      ...rest,
      migrations: migrations(p).filter(
        (m) =>
          m !== LEARNING_AUTHORIZATION_MIGRATION &&
          m !== LEARNING_AUTHORITY_MIGRATION &&
          m !== COMMUNITY_PROFILE_MIGRATION &&
          !retainedFeatures.includes(m),
      ),
    };
  };
  assertPublishingApplicationUpgrade(strip(previous), strip(next));
}
