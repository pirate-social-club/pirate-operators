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
