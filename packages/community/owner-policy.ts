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
