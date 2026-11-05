import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import { validateReleaseGrant } from "../packages/release/grant.ts";

export const curatedBaselines = {
  application:
    "0xb93ff3d5997db70680859bdd5dcc7217c2633ac9801e3766e979ad5738a3cf65",
  managed: "0x084b589a0571e758b23e0d3198d0d00d613ba3d9a2cbdb750f8c6a0c8c0dfef7",
} as const;
export const heldStateHash =
  "0x307f252c567cb182c85c5aaa2fb0c0b86271f8366567ebc97054b4726927d52c";
/** One exact known-held source transition. Old/new grants share aggregate
 * periods and limits; all predecessor public-effect intents must be absent. */
export function assertCuratedUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  side: keyof typeof curatedBaselines,
) {
  insist(
    hashJson(previous) === curatedBaselines[side] &&
      hashJson(next.curatedState) === heldStateHash,
    "curated_upgrade_baseline_changed",
    409,
  );
  const old = validateReleaseGrant(previous.releaseGrant),
    grant = validateReleaseGrant(next.releaseGrant);
  const spending = (g: typeof grant) => {
    const { sha256, configurationRevision, pins, registration, ...scope } = g,
      { sha256: pinHash, ...pinBounds } = pins,
      { sha256: rootHash, ...rootBounds } = registration;
    return { ...scope, pins: pinBounds, registration: rootBounds };
  };
  insist(
    old.configurationRevision === 1 &&
      grant.configurationRevision === 2 &&
      old.sha256 !== grant.sha256 &&
      canonical(spending(old)) === canonical(spending(grant)),
    "curated_upgrade_changes_spending_or_recipient",
    409,
  );
  const allowed = [
      "sourceHashes",
      "bundleSha256",
      "bundleBytes",
      "assets",
      "migrations",
      "releaseGrant",
      "reviewedUpdate",
      "update",
      "curatedState",
      ...(side === "application"
        ? ["managedProfileHash", "creatorProfileHash"]
        : []),
    ],
    unchanged = (p: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(p).filter(([k]) => !allowed.includes(k)),
      );
  insist(
    canonical(unchanged(previous)) === canonical(unchanged(next)),
    "curated_upgrade_changes_resource_or_credential_intent",
    409,
  );
  const additions =
    side === "application"
      ? ["0006_song_stems.sql", "0007_owner_curated.sql"]
      : ["0003_owner_curated.sql"];
  insist(
    canonical(next.migrations) ===
      canonical([...(previous.migrations as string[]), ...additions]),
    "curated_upgrade_migrations_changed",
    409,
  );
}
