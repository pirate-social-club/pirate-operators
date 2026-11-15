import test from "node:test";
import assert from "node:assert/strict";
import { web2DirectoryFixture, a } from "./fixtures/web2-directory.ts";
import {
  readWeb2Community,
  evaluateWeb2Eligibility,
} from "../packages/community/web2-directory-reader.ts";

// Failure cases: swapped proof-type responses, stale accepted generations,
// observations at/before the cutoff, first-proof generation zero, mutable
// authority facts changing a retained snapshot, and fresh recovery extending
// the safe-block clock or restoring listing. The RPC facts are independent;
// Forge tests own the actual invalidation and pending-transaction transitions.

test("V3 snapshots pin independent current and accepted proof generations at the safe block", async () => {
  const f = await web2DirectoryFixture();
  f.authority.web2.generation = 2n;
  f.authority.web2.invalidatedAt = 65535n;
  f.state.web2VerifiedAtBlock = false;
  f.authority.hns.acceptedGeneration = 1n;
  f.state.hnsVerifiedAtBlock = true;
  f.state.hnsValidUntil = f.state.now + 20n;
  const result = await readWeb2Community(
    f.client,
    f.profile,
    f.policy,
    f.transport,
  );
  const s = result.verificationSnapshot;
  assert.equal(s.schema, "pirate.directory-verification-snapshot/2");
  assert.equal(s.listingRevision, 1n);
  assert.equal(s.web2.acceptedGeneration, 1n);
  assert.deepEqual(s.web2.authority, {
    verifier: a("8"),
    generation: 2n,
    invalidatedAt: 65535n,
  });
  assert.equal(s.hns.acceptedGeneration, 1n);
  assert.deepEqual(s.hns.authority, {
    verifier: a("9"),
    generation: 1n,
    invalidatedAt: 0n,
  });
  assert.ok(
    Object.isFrozen(s.web2.authority) && Object.isFrozen(s.hns.authority),
  );
  assert.throws(
    () => Object.assign(s.web2.authority, { generation: 1n }),
    TypeError,
  );
  assert.equal(result.eligibility.status, "available");
  if (result.eligibility.status !== "available")
    throw new Error("unexpected unavailable eligibility");
  assert.equal(result.eligibility.web2Verified, false);
  assert.equal(result.eligibility.hnsVerified, true);
  assert.equal(result.eligibility.discoverable, true);
  for (const name of [
    "getWeb2ProofAuthority",
    "getHnsProofAuthority",
    "getWeb2ProofGeneration",
    "getHnsProofGeneration",
  ])
    assert.ok(
      f.state.contractReadBlocks.some(
        ([method, block]) =>
          method === name && block === `0x${s.blockNumber.toString(16)}`,
      ),
    );
  const expired = evaluateWeb2Eligibility(s, f.state.now + 20n, 100n);
  assert.equal(expired.status, "available");
  if (expired.status !== "available")
    throw new Error("unexpected unavailable eligibility");
  assert.equal(expired.web2Verified, false);
  assert.equal(expired.hnsVerified, false);
  assert.equal(expired.discoverable, false);
  f.authority.web2.generation = 3n;
  f.authority.hns.verifier = a("7");
  assert.equal(s.web2.authority.generation, 2n);
  assert.equal(s.hns.authority.verifier, a("9"));
});

test("V3 reader refuses claimed validity from an old generation or an observation at/before invalidation", async () => {
  for (const type of ["web2", "hns"] as const) {
    for (const fault of [
      "generation",
      "before-cutoff",
      "same-block",
    ] as const) {
      const f = await web2DirectoryFixture();
      f.state.hnsVerifiedAtBlock = true;
      f.state.hnsValidUntil = f.state.now + 20n;
      f.authority.hns.acceptedGeneration = 1n;
      const authority = f.authority[type];
      authority.generation = 2n;
      authority.acceptedGeneration = fault === "generation" ? 1n : 2n;
      authority.invalidatedAt = fault === "generation" ? 65535n : 65536n;
      if (fault === "before-cutoff") {
        f.state[`${type}ObservedAt`] = 65535n;
      }
      await assert.rejects(
        readWeb2Community(f.client, f.profile, f.policy, f.transport),
        /directory_verification_snapshot_mismatch/,
      );
    }
  }
});

test("fresh proof in the current generation recovers eligibility without resetting snapshot freshness", async () => {
  for (const type of ["web2", "hns"] as const) {
    const f = await web2DirectoryFixture();
    f.state.web2VerifiedAtBlock = type === "web2";
    f.state.hnsVerifiedAtBlock = type === "hns";
    f.state.hnsValidUntil = f.state.now + 20n;
    f.authority.hns.acceptedGeneration = 1n;
    f.authority[type].generation = 2n;
    f.authority[type].acceptedGeneration = 2n;
    f.authority[type].invalidatedAt = 65535n;
    const result = await readWeb2Community(
      f.client,
      f.profile,
      f.policy,
      f.transport,
    );
    assert.equal(result.eligibility.status, "available");
    if (result.eligibility.status !== "available")
      throw new Error("unexpected unavailable eligibility");
    assert.equal(result.eligibility.web2Verified, type === "web2");
    assert.equal(result.eligibility.hnsVerified, type === "hns");
    assert.equal(result.eligibility.discoverable, true);
    const stale = evaluateWeb2Eligibility(
      result.verificationSnapshot,
      f.state.now + 101n,
      100n,
    );
    assert.equal(stale.status, "unavailable");
    if (stale.status !== "unavailable")
      throw new Error("stale authority accepted");
    assert.equal(stale.reason, "safe_block_stale");
    assert.equal(
      result.verificationSnapshot[type].authority.invalidatedAt,
      65535n,
    );
    f.state.listed = false;
    const delisted = await readWeb2Community(
      f.client,
      f.profile,
      f.policy,
      f.transport,
    );
    assert.equal(delisted.eligibility.status, "available");
    if (delisted.eligibility.status !== "available")
      throw new Error("unexpected unavailable eligibility");
    assert.equal(delisted.eligibility.discoverable, false);
  }
});

test("a community without an HNS proof retains generation zero across HNS emergencies", async () => {
  const f = await web2DirectoryFixture();
  f.authority.hns.generation = 4n;
  f.authority.hns.invalidatedAt = 65536n;
  const result = await readWeb2Community(
    f.client,
    f.profile,
    f.policy,
    f.transport,
  );
  assert.equal(result.verificationSnapshot.hns.revision, 0n);
  assert.equal(result.verificationSnapshot.hns.acceptedGeneration, 0n);
  assert.equal(result.verificationSnapshot.hns.authority.generation, 4n);
  assert.equal(result.eligibility.status, "available");
  if (result.eligibility.status !== "available")
    throw new Error("unexpected unavailable eligibility");
  assert.equal(result.eligibility.web2Verified, true);
  assert.equal(result.eligibility.hnsVerified, false);
  assert.equal(result.eligibility.discoverable, true);
});

test("invalidating HNS preserves an independent newer Web2 generation", async () => {
  const f = await web2DirectoryFixture();
  f.authority.web2.generation = 3n;
  f.authority.web2.acceptedGeneration = 3n;
  f.authority.web2.invalidatedAt = 65534n;
  f.authority.hns.generation = 7n;
  f.authority.hns.acceptedGeneration = 6n;
  f.authority.hns.invalidatedAt = 65535n;
  f.state.hnsValidUntil = f.state.now + 20n;
  const result = await readWeb2Community(
    f.client,
    f.profile,
    f.policy,
    f.transport,
  );
  assert.equal(result.verificationSnapshot.web2.authority.generation, 3n);
  assert.equal(result.verificationSnapshot.hns.authority.generation, 7n);
  assert.equal(result.verificationSnapshot.hns.acceptedGeneration, 6n);
  assert.equal(result.eligibility.status, "available");
  if (result.eligibility.status !== "available")
    throw new Error("unexpected unavailable eligibility");
  assert.equal(result.eligibility.web2Verified, true);
  assert.equal(result.eligibility.hnsVerified, false);
  assert.equal(result.eligibility.discoverable, true);
});
