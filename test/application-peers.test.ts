import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertApplicationPeers } from "../harness/first-song-peers.ts";

const { profile } = JSON.parse(
  await readFile(
    "docs/deployments/first-song-managed-20261105.application-plan.json",
    "utf8",
  ),
);
const native = { profileHash: profile.creatorProfileHash, testnet: true };
const managed = {
  profileHash: profile.managedProfileHash,
  release: {
    configured: true,
    grantSha256: profile.releaseGrant.sha256,
    registrationOperator: profile.releaseGrant.registration.operator,
  },
};
const expires = profile.releaseGrant.expiresAt;
const disabled = { ...managed, release: { configured: false } };

test("an active publication still requires exact configured release peers", () => {
  assertApplicationPeers(profile, native, managed, expires - 1);
  for (const reviewed of [false, true]) {
    assert.throws(
      () =>
        assertApplicationPeers(
          profile,
          native,
          disabled,
          expires - 1,
          reviewed,
        ),
      /peer_unqualified/,
    );
    assert.throws(
      () =>
        assertApplicationPeers(
          profile,
          native,
          {
            ...managed,
            release: { ...managed.release, grantSha256: "different" },
          },
          expires - 1,
          reviewed,
        ),
      /peer_unqualified/,
    );
  }
});

test("only an explicit update of the pinned published state accepts an expired disabled release", () => {
  assertApplicationPeers(profile, native, disabled, expires, true);
  assertApplicationPeers(profile, native, disabled, expires + 86400, true);
  assert.throws(
    () => assertApplicationPeers(profile, native, disabled, expires),
    /peer_unqualified/,
  );
  assert.throws(
    () => assertApplicationPeers(profile, native, managed, expires, true),
    /peer_unqualified/,
  );
  for (const changed of [
    { ...profile, reviewedUpdate: undefined },
    {
      ...profile,
      curatedState: {
        ...profile.curatedState,
        schema: "pirate.held-first-song-state/1",
      },
    },
    { ...profile, curatedState: { ...profile.curatedState, application: {} } },
  ])
    assert.throws(
      () => assertApplicationPeers(changed, native, disabled, expires, true),
      /peer_unqualified/,
    );
});

test("an expired published update still refuses changed peers and a non-testnet creator", () => {
  for (const changed of [
    { ...native, profileHash: "different" },
    { ...native, testnet: false },
  ])
    assert.throws(
      () => assertApplicationPeers(profile, changed, disabled, expires, true),
      /peer_unqualified/,
    );
  assert.throws(
    () =>
      assertApplicationPeers(
        profile,
        native,
        { ...disabled, profileHash: "different" },
        expires,
        true,
      ),
    /peer_unqualified/,
  );
});

test("an expired peer must not contradict the retained grant or operator", () => {
  for (const changed of [
    { grantSha256: "different" },
    { registrationOperator: "different" },
    { expiresAt: expires + 1 },
    { grantSha256: null },
    { registrationOperator: null },
  ])
    assert.throws(
      () =>
        assertApplicationPeers(
          profile,
          native,
          {
            ...disabled,
            release: { configured: false, ...changed },
          },
          expires,
          true,
        ),
      /peer_unqualified/,
    );
  assertApplicationPeers(
    profile,
    native,
    {
      ...managed,
      release: { ...managed.release, configured: false, expiresAt: expires },
    },
    expires,
    true,
  );
});

test("owner publishing needs no creator peer and exactly the selection's owner release on the pinned managed profile", async () => {
  const { ownerGrantDigest, validateOwnerGrant } = await import(
    "../packages/release/owner-grant.ts"
  );
  const { communityPublishingProfile, publishingReleaseSelection } =
    await import("../harness/publishing-release-profile.ts");
  const { UNREGISTERED_OWNER_POLICY_HASH, UNREGISTERED_OWNER_POLICY_VERSION } =
    await import("../packages/community/owner-policy.ts");
  const policy = {
      version: UNREGISTERED_OWNER_POLICY_VERSION,
      sha256: UNREGISTERED_OWNER_POLICY_HASH,
    },
    window = { validFrom: 2000000000, expiresAt: 2000604800 },
    owner = "0x" + "ab".repeat(20);
  const draft = {
    schema: "pirate.owner-publishing-grant/1" as const,
    sha256: "0x" + "00".repeat(32),
    communityId: "0x" + "d3".repeat(32),
    communityOrigin: profile.origin,
    ownerWallet: owner,
    policy,
    destination: {
      chainId: 6343,
      postsContract: "0x" + "11".repeat(20),
      publisher: "0x" + "22".repeat(20),
    },
    ...window,
    limits: {
      songs: 2,
      pinAdds: 6,
      pinBytes: "54525952",
      recognitionRequests: 4,
      postFeeWei: "2000000000000",
    },
  };
  const ownerGrant = validateOwnerGrant({
    ...draft,
    sha256: ownerGrantDigest(draft),
  });
  // Format only: the signature is checked at runtime, not by this peer rule.
  const selection = publishingReleaseSelection({
    schema: "pirate.owner-publishing-release-selection/1",
    ownerGrant,
    ownerAuthorization: {
      authorization: {
        schema: "pirate.owner-publishing-authorization/1",
        communityId: ownerGrant.communityId,
        ownerWallet: owner,
        policy,
        ...window,
      },
      signature: "0x" + "1".repeat(130),
    },
  });
  const owned = communityPublishingProfile(profile, selection) as any,
    peer = {
      profileHash: owned.managedProfileHash,
      release: { configured: false },
      ownerRelease: {
        configured: true,
        grantSha256: ownerGrant.sha256,
        expiresAt: ownerGrant.expiresAt,
      },
    },
    inside = window.validFrom + 60;
  // No creator health is required; an empty native peer is accepted.
  assertApplicationPeers(owned, {}, peer, inside, true);
  for (const [name, changed, at] of [
    ["managed profile", { ...peer, profileHash: "0x" + "33".repeat(32) }],
    ["registered release", { ...peer, release: { configured: true } }],
    ["unconfigured", { ...peer, ownerRelease: { configured: false } }],
    [
      "other grant",
      {
        ...peer,
        ownerRelease: { ...peer.ownerRelease, grantSha256: "0x" + "44".repeat(32) },
      },
    ],
    [
      "other window",
      {
        ...peer,
        ownerRelease: { ...peer.ownerRelease, expiresAt: window.expiresAt + 1 },
      },
    ],
    ["expired", peer, window.expiresAt],
    ["not yet valid", peer, window.validFrom - 1],
  ] as const)
    assert.throws(
      () =>
        assertApplicationPeers(owned, {}, changed, at ?? inside, true),
      /application_owner_peer_unqualified/,
      name,
    );
});
