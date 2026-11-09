import { hashJson } from "./common.ts";

/** Normative owner-curated MVP policy. V1 remains a separate immutable policy. */
export const OWNER_POLICY = {
  version: "pirate-owner-curated/2026-11-05/1",
  creatorScope:
    "operator-authorized owner wallet and captured creator recipient",
  lineage: "root",
  recognition: {
    required: true,
    provider: "acrcloud",
    maximumAgeSeconds: 86400,
    retainedReceipts: "original acquisition time; never reset on adoption",
    identified: "block",
    inconclusive: "hold",
  },
  contentModeration:
    "deferred; no automated content evidence required or claimed",
  ratingAndLanguage:
    "explicit operator declaration, not automated classification",
  publication:
    "verified wallet, immutable master and lyrics, both private MP3 stems, retained public artifacts, confirmed ROOT registration and MegaETH post",
  funding:
    "finite reviewed operator grant; amendments never replenish aggregate allowances",
} as const;
export const OWNER_POLICY_VERSION = OWNER_POLICY.version;
export const OWNER_POLICY_HASH = hashJson(OWNER_POLICY);
export const ownerCurated = (policy: { version: string; sha256: string }) =>
  policy.version === OWNER_POLICY_VERSION &&
  policy.sha256 === OWNER_POLICY_HASH;

/**
 * Owner-only launch policy adopted on 2026-11-08 (docs/megaeth-song-publication.md).
 * External registration is explicitly absent. It never reinterprets posts made
 * under OWNER_POLICY, whose bytes and hash stay unchanged above.
 */
export const UNREGISTERED_OWNER_POLICY = {
  version: "pirate-owner-curated/2026-11-08/1",
  creatorScope: "operator-authorized owner account; no creator wallet",
  lineage: "root",
  recognition: {
    required: true,
    provider: "acrcloud",
    maximumAgeSeconds: 86400,
    retainedReceipts: "original acquisition time; never reset",
    identified: "block",
    inconclusive: "hold",
  },
  contentModeration:
    "deferred; no automated content evidence required or claimed",
  ratingAndLanguage:
    "explicit operator declaration, not automated classification",
  registration: "absent; external registration deferred for launch",
  publication:
    "authorized owner account, immutable master and lyrics, both private MP3 stems, retained public artifacts and MegaETH post",
  funding:
    "finite reviewed operator grant; no registration operation or registration fee",
} as const;
export const UNREGISTERED_OWNER_POLICY_VERSION =
  UNREGISTERED_OWNER_POLICY.version;
export const UNREGISTERED_OWNER_POLICY_HASH = hashJson(
  UNREGISTERED_OWNER_POLICY,
);
export const unregisteredOwner = (policy: {
  version: string;
  sha256: string;
}) =>
  policy.version === UNREGISTERED_OWNER_POLICY_VERSION &&
  policy.sha256 === UNREGISTERED_OWNER_POLICY_HASH;
