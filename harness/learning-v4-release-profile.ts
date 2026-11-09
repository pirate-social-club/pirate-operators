// Public configuration only. Reading or validating this input never deploys
// the V4 contract, grants a grader role or changes the directory; release
// custody does those. Selecting V4 adds migration 0013 after the deployed 0012.
import { open } from "node:fs/promises";
import {
  canonical,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  LEARNING_AUTHORIZATION_MIGRATION,
  OWNER_PUBLISHING_MIGRATION,
} from "./package-migrations.ts";
import { assertPublishingApplicationUpgrade } from "./publishing-release-profile.ts";

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
      p.policyVersion === 4,
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
 * It appends only migration 0013 after the deployed 0012 and adds the reviewed
 * V4 selection. Once those are stripped, the rest is delegated to the
 * publishing gate, which delegates to the rewards and Study gates. A V4
 * profile may succeed another only with the same selection and migrations.
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
  if (previous.learningV4) {
    insist(
      canonical(learningV4ReleaseSelection(previous.learningV4)) ===
        canonical(selection),
      "learning_v4_selection_changed",
      409,
    );
    insist(
      before.at(-1) === LEARNING_AUTHORIZATION_MIGRATION &&
        canonical(after) === canonical(before),
      "learning_v4_migrations_changed",
      409,
    );
  } else
    insist(
      before.at(-1) === OWNER_PUBLISHING_MIGRATION &&
        !before.includes(LEARNING_AUTHORIZATION_MIGRATION) &&
        canonical(after) ===
          canonical([...before, LEARNING_AUTHORIZATION_MIGRATION]),
      "learning_v4_migrations_changed",
      409,
    );
  const strip = (p: Record<string, unknown>) => {
    const { learningV4: _, ...rest } = p;
    return {
      ...rest,
      migrations: migrations(p).filter(
        (m) => m !== LEARNING_AUTHORIZATION_MIGRATION,
      ),
    };
  };
  assertPublishingApplicationUpgrade(strip(previous), strip(next));
}
