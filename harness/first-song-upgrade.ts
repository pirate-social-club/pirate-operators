// One explicit functional transition from the independently qualified idle
// gateway profiles. Generic reviewed updates still forbid changed intent.
import { readFile } from "node:fs/promises";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import { validateReleaseGrant } from "../packages/release/grant.ts";
import { firstSong } from "../services/first-song-profile.ts";

export const releaseGrantPath =
  "docs/deployments/first-song-managed-20261105.owner-curated-grant.json";
export async function firstSongGrant() {
  return validateReleaseGrant(
    JSON.parse(await readFile(releaseGrantPath, "utf8")),
  );
}
export const functionalBaselines = {
  application:
    "0x968dfa65112ca99aeb1ceef68da0501891a24aa6da5a07c801f5d11b4acf8dfb",
  managed: "0x9756688b945fc4666d5e9085bd65e1c9ef7e2391f2871ace5a1980c8ee2e07d9",
} as const;
export function assertFirstSongUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  kind: keyof typeof functionalBaselines,
) {
  insist(
    hashJson(previous) === functionalBaselines[kind],
    "first_song_upgrade_baseline_changed",
    409,
  );
  const grant = validateReleaseGrant(next.releaseGrant);
  insist(
    grant.communityId === firstSong.directoryProfile.communityId &&
      grant.communityOrigin === firstSong.origin &&
      grant.configurationRevision === 1 &&
      grant.publisher === "0x14b90a55657d9695a727254eaec5e0e32d20d602" &&
      grant.recipient === "0x3245599b2d2c2d6d9123790b77f218959e81aa40" &&
      grant.contentSha256 ===
        "0xc1cd8f562c7aad2c37b815ce74f2a83335143ccca1f7ac5bc49563fcaf73b179" &&
      grant.registration.operator ===
        "0xbf85a150114d3df8b90a7793c0ea4b2f4bb8c319" &&
      grant.registration.maximumGas === "10000000" &&
      grant.registration.maximumGasPrice === "10000000" &&
      grant.registration.maximumTotalFee === "100000000000000" &&
      grant.pins.period === "first-song-20261105-v1",
    "first_song_upgrade_grant_changed",
    409,
  );
  const common = [
      "sourceHashes",
      "bundleSha256",
      "bundleBytes",
      "releaseGrant",
      "bounds",
      "migrations",
    ],
    changed =
      kind === "application"
        ? [
            ...common,
            "reviewedUpdate",
            "assets",
            "acceptance",
            "queueConsumer",
            "managedProfileHash",
          ]
        : [...common, "update", "secretNames", "registrationCredential"],
    omit = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !changed.includes(key)),
      );
  insist(
    canonical(omit(previous)) === canonical(omit(next)),
    "first_song_upgrade_unrelated_intent_changed",
    409,
  );
  const expectedBounds =
    kind === "application"
      ? {
          executionSeconds: 900,
          newResources: 1,
          nativeTransactions: 0,
          providerRequests: 24,
          registrationTransactions: 1,
          publicationTransactions: 1,
          publicPins: 5,
          maximumRegistrationFee: grant.registration.maximumTotalFee,
          maximumPublicationFee: "30000000000000",
        }
      : {
          executionSeconds: 900,
          healthSeconds: 60,
          providerRequests: 24,
          registrationTransactions: 1,
          paymentDeposits: 0,
          publicPins: 5,
          maximumRegistrationFee: grant.registration.maximumTotalFee,
        };
  insist(
    canonical(next.bounds) === canonical(expectedBounds),
    "first_song_upgrade_spending_changed",
    409,
  );
  if (kind === "application") {
    insist(
      typeof next.managedProfileHash === "string" &&
        /^0x[0-9a-f]{64}$/.test(next.managedProfileHash) &&
        canonical(next.migrations) ===
          canonical([
            ...(previous.migrations as string[]),
            "0005_input_capabilities.sql",
          ]) &&
        next.acceptance ===
          "Managed first-song ROOT publication, interrupted processing and anonymous playback after reload" &&
        canonical(next.queueConsumer) ===
          canonical({
            logical: "Consumer",
            queueId: "fe031cd96fbb47579585eb10154f785d",
            scriptName: "pirate-first-song-20261105",
            batchSize: 1,
            maxConcurrency: 1,
            maxRetries: 3,
            retryDelay: 60,
          }),
      "first_song_upgrade_application_scope_changed",
      409,
    );
  } else {
    const credential = object(next.registrationCredential);
    insist(
      credential.path ===
        "~/.config/pirate-operators/megaeth-testnet/keys.json" &&
        credential.sha256 ===
          "0x820df8fd4ef8c07d04ce93042623b1d3265bed78c05247e1d3e3626726484034" &&
        credential.sourceField === "keys.communityAdmin" &&
        credential.sourceChain === 6343 &&
        credential.targetChain === 1315 &&
        credential.mode === "600" &&
        credential.owner === "current_operator_uid",
      "first_song_registration_credential_changed",
      409,
    );
    insist(
      canonical(next.migrations) ===
        canonical(["0001_managed.sql", "0002_release_operations.sql"]) &&
        canonical(next.secretNames) ===
          canonical([
            ...(previous.secretNames as string[]),
            "FILEBASE_IPFS_TOKEN",
            "REGISTRATION_OPERATOR_PRIVATE_KEY",
          ]),
      "first_song_upgrade_managed_scope_changed",
      409,
    );
  }
}
