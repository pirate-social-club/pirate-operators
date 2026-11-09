// Public configuration only. Reading or validating this input never publishes,
// spends or activates the owner policy; the directory configuration does that.
import { open } from "node:fs/promises";
import {
  bytes32,
  canonical,
  hashJson,
  exact,
  insist,
  integer,
  object,
} from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import {
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { unregisteredOwner } from "../packages/community/owner-policy.ts";
import type { SignedOwnerAuthorization } from "../packages/community/owner-authorization.ts";
import { assertRewardsApplicationUpgrade } from "./rewards-release-profile.ts";
import { publishedStateRepairHash } from "./published-state.ts";
import {
  MANAGED_OWNER_PUBLISHING_MIGRATION,
  OWNER_PUBLISHING_MIGRATION,
} from "./package-migrations.ts";

/**
 * The reviewed owner publishing inputs for a release: the owner budget grant
 * both services hold, and the controller-signed owner authorization the
 * community worker checks. The authorization signature is verified against the
 * directory controller at runtime; here its scope must match the grant.
 */
export interface PublishingReleaseSelection {
  schema: "pirate.owner-publishing-release-selection/1";
  ownerGrant: OwnerBudgetGrant;
  ownerAuthorization: SignedOwnerAuthorization;
}
export function publishingReleaseSelection(
  value: unknown,
): PublishingReleaseSelection {
  const p = object(value);
  exact(p, ["schema", "ownerGrant", "ownerAuthorization"]);
  insist(
    p.schema === "pirate.owner-publishing-release-selection/1",
    "owner_publishing_release_schema_invalid",
    409,
  );
  const ownerGrant = validateOwnerGrant(p.ownerGrant),
    signed = object(p.ownerAuthorization);
  exact(signed, ["authorization", "signature"]);
  const a = object(signed.authorization);
  exact(a, [
    "schema",
    "communityId",
    "ownerWallet",
    "policy",
    "validFrom",
    "expiresAt",
  ]);
  const policy = object(a.policy);
  exact(policy, ["version", "sha256"]);
  const authorization = {
    schema: "pirate.owner-publishing-authorization/1" as const,
    communityId: bytes32(a.communityId),
    ownerWallet: address(a.ownerWallet),
    policy: { version: String(policy.version), sha256: bytes32(policy.sha256) },
    validFrom: integer(a.validFrom, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    a.schema === authorization.schema &&
      typeof signed.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(signed.signature) &&
      unregisteredOwner(authorization.policy) &&
      authorization.validFrom < authorization.expiresAt &&
      authorization.communityId === ownerGrant.communityId &&
      authorization.ownerWallet === ownerGrant.ownerWallet &&
      canonical(authorization.policy) === canonical(ownerGrant.policy),
    "owner_publishing_release_scope_mismatch",
    409,
  );
  const selection: PublishingReleaseSelection = {
    schema: "pirate.owner-publishing-release-selection/1",
    ownerGrant,
    ownerAuthorization: {
      authorization,
      signature: signed.signature as `0x${string}`,
    },
  };
  insist(
    canonical(p) === canonical(selection),
    "owner_publishing_release_noncanonical",
    409,
  );
  return selection;
}
export async function readPublishingReleaseSelection(path: string) {
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
  insist(size <= 65536, "owner_publishing_release_too_large", 409);
  return publishingReleaseSelection(
    JSON.parse(raw.subarray(0, size).toString("utf8")),
  );
}

/** Registration-only spending bounds a publishing profile does not carry. */
const REGISTRATION_BOUNDS = [
  "registrationTransactions",
  "maximumRegistrationFee",
] as const;
const withoutRegistrationBounds = (bounds: unknown) =>
  Object.fromEntries(
    Object.entries(object(bounds)).filter(
      ([k]) => !(REGISTRATION_BOUNDS as readonly string[]).includes(k),
    ),
  );
/** Registered-release fields of the community application profile. */
const COMMUNITY_REGISTERED_FIELDS = ["releaseGrant", "creatorProfileHash"];
/** Registered-release fields of the managed service profile. */
const MANAGED_REGISTERED_FIELDS = ["releaseGrant", "registrationCredential"];
/**
 * The keys-file digest still protects the moderation signer source; only the
 * registration target chain is dropped.
 */
const signerSource = (credential: unknown) => {
  const { targetChain: _, ...source } = object(credential);
  return source;
};
const REGISTRATION_SECRET = "REGISTRATION_OPERATOR_PRIVATE_KEY";

/**
 * The community application profile under owner publishing: the reviewed
 * selection replaces the registered release grant and creator profile, and
 * registration bounds are removed. Everything else is unchanged.
 */
export function communityPublishingProfile<T extends Record<string, unknown>>(
  profile: T,
  selection: PublishingReleaseSelection,
) {
  const next: Record<string, unknown> = { ...profile };
  for (const key of COMMUNITY_REGISTERED_FIELDS) delete next[key];
  next.bounds = withoutRegistrationBounds(profile.bounds);
  next.ownerPublishing = publishingReleaseSelection(selection);
  return next;
}
/**
 * The managed service profile under owner publishing: the owner grant
 * replaces the registered release grant, the registration key leaves the
 * required secrets, and registration bounds are removed.
 */
export function managedPublishingProfile<T extends Record<string, unknown>>(
  profile: T,
  selection: PublishingReleaseSelection,
) {
  const next: Record<string, unknown> = { ...profile };
  for (const key of MANAGED_REGISTERED_FIELDS) delete next[key];
  next.bounds = withoutRegistrationBounds(profile.bounds);
  next.secretNames = (profile.secretNames as string[]).filter(
    (name) => name !== REGISTRATION_SECRET,
  );
  next.signerSource = signerSource(profile.registrationCredential);
  next.ownerGrant = publishingReleaseSelection(selection).ownerGrant;
  return next;
}

/** Same community, owner, policy and destination; only the window may move. */
function assertSameOwnerScope(
  previous: OwnerBudgetGrant,
  next: OwnerBudgetGrant,
) {
  insist(
    previous.communityId === next.communityId &&
      previous.communityOrigin === next.communityOrigin &&
      previous.ownerWallet === next.ownerWallet &&
      canonical(previous.policy) === canonical(next.policy) &&
      canonical(previous.destination) === canonical(next.destination),
    "owner_publishing_scope_changed",
    409,
  );
}

/**
 * Publishing successor of a deployed Study and rewards application. It
 * appends only migration 0012, adds the reviewed owner selection and removes
 * the registered release fields and registration bounds. The rewards program,
 * the Study deployment and every other field must be unchanged; that part is
 * delegated to the existing rewards and Study gates. A publishing profile may
 * succeed another one with a replacement grant for the same owner scope.
 * Schema order is separate from financial activation: this adds no rewards
 * funding or payout requirement.
 */
export function assertPublishingApplicationUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const selection = publishingReleaseSelection(next.ownerPublishing);
  insist(
    previous.rewards && next.rewards,
    "owner_publishing_rewards_required",
    409,
  );
  for (const key of COMMUNITY_REGISTERED_FIELDS)
    insist(!(key in next), "owner_publishing_registered_field_kept", 409);
  insist(
    !REGISTRATION_BOUNDS.some((k) => k in object(next.bounds)),
    "owner_publishing_registration_bounds_kept",
    409,
  );
  const migrations = (p: Record<string, unknown>) => {
    insist(
      Array.isArray(p.migrations) &&
        p.migrations.every((m) => typeof m === "string") &&
        new Set(p.migrations).size === p.migrations.length,
      "owner_publishing_migrations_invalid",
      409,
    );
    return p.migrations as string[];
  };
  const before = migrations(previous),
    after = migrations(next);
  if (previous.ownerPublishing) {
    assertSameOwnerScope(
      publishingReleaseSelection(previous.ownerPublishing).ownerGrant,
      selection.ownerGrant,
    );
    insist(
      before.at(-1) === OWNER_PUBLISHING_MIGRATION &&
        canonical(after) === canonical(before),
      "owner_publishing_migrations_changed",
      409,
    );
  } else
    insist(
      before.at(-1) === "0011_manual_rewards.sql" &&
        !before.includes(OWNER_PUBLISHING_MIGRATION) &&
        canonical(after) === canonical([...before, OWNER_PUBLISHING_MIGRATION]),
      "owner_publishing_migrations_changed",
      409,
    );
  // The managed profile hash follows the reviewed managed publishing package.
  insist(
    typeof next.managedProfileHash === "string" &&
      /^0x[0-9a-f]{64}$/.test(next.managedProfileHash),
    "owner_publishing_managed_profile_invalid",
    409,
  );
  const normalize = (p: Record<string, unknown>) => {
    const rest: Record<string, unknown> = { ...p };
    delete rest.ownerPublishing;
    for (const key of COMMUNITY_REGISTERED_FIELDS) delete rest[key];
    rest.bounds = withoutRegistrationBounds(p.bounds);
    rest.managedProfileHash = "publishing";
    rest.migrations = migrations(p).filter(
      (m) => m !== OWNER_PUBLISHING_MIGRATION,
    );
    return rest;
  };
  assertRewardsApplicationUpgrade(normalize(previous), normalize(next));
}

/**
 * Publishing successor of the deployed managed service: appends only managed
 * migration 0004, replaces the registered release grant with the owner grant,
 * drops the registration key and registration bounds. Everything else,
 * including pairings, provider caps and signer, is unchanged.
 */
export function assertPublishingManagedUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const grant = validateOwnerGrant(next.ownerGrant);
  // Only the one reviewed managed-state successor may be added.
  insist(
    next.curatedStateRepair === undefined ||
      hashJson(next.curatedStateRepair) === publishedStateRepairHash,
    "owner_publishing_state_repair_changed",
    409,
  );
  for (const key of MANAGED_REGISTERED_FIELDS)
    insist(!(key in next), "owner_publishing_registered_field_kept", 409);
  insist(
    !(next.secretNames as string[]).includes(REGISTRATION_SECRET) &&
      !REGISTRATION_BOUNDS.some((k) => k in object(next.bounds)),
    "owner_publishing_registration_kept",
    409,
  );
  const before = previous.migrations as string[],
    after = next.migrations as string[];
  if (previous.ownerGrant) {
    assertSameOwnerScope(validateOwnerGrant(previous.ownerGrant), grant);
    insist(
      canonical(after) === canonical(before),
      "owner_publishing_migrations_changed",
      409,
    );
  } else
    insist(
      Array.isArray(before) &&
        !before.includes(MANAGED_OWNER_PUBLISHING_MIGRATION) &&
        canonical(after) ===
          canonical([...before, MANAGED_OWNER_PUBLISHING_MIGRATION]),
      "owner_publishing_migrations_changed",
      409,
    );
  const changed = new Set([
    "sourceHashes",
    "bundleSha256",
    "bundleBytes",
    "migrations",
    "reviewedUpdate",
    "update",
    "ownerGrant",
    "releaseGrant",
    "registrationCredential",
    "signerSource",
    "secretNames",
    "bounds",
    "curatedStateRepair",
  ]);
  const fixed = (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !changed.has(k)));
  insist(
    canonical(fixed(previous)) === canonical(fixed(next)) &&
      canonical(withoutRegistrationBounds(previous.bounds)) ===
        canonical(next.bounds) &&
      canonical(
        previous.signerSource ?? signerSource(previous.registrationCredential),
      ) === canonical(next.signerSource) &&
      canonical(
        (previous.secretNames as string[]).filter(
          (n) => n !== REGISTRATION_SECRET,
        ),
      ) === canonical(next.secretNames),
    "owner_publishing_unrelated_intent_changed",
    409,
  );
}
