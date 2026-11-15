import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import { sharedDirectoryFixture } from "./fixtures/shared-directory.ts";
import { directoryInstanceId, sharedNamespaceId, canonicalTld } from "../packages/community/shared-identity.ts";
import { communityId } from "../packages/community/manifest-core.ts";
import { validateSharedProfile, sharedBinding, sharedProfileDocument, parseSharedProfileDocument } from "../packages/community/shared-directory.ts";
import { validateSharedConfig } from "../packages/community/shared-config-manifest.ts";
import { configurationState } from "../packages/community/config-manifest.ts";
import { selectSharedProfile } from "../harness/megaeth/adopt-profile-shared.ts";

test("shared identity is key/chain scoped, not registry scoped or an old ID reinterpretation", async () => {
  const f = await sharedDirectoryFixture(), p = f.profile;
  assert.equal(p.communityId, keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [keccak256(stringToHex("pirate.community/2")), 31337n, p.communityKey])));
  assert.notEqual(directoryInstanceId(6343, p.communityKey), p.communityId);
  assert.notEqual(communityId(31337, p.registry), p.communityId);
  assert.equal(validateSharedProfile({ ...p, registry: "0x" + "9".repeat(40) }).communityId, p.communityId);
  assert.notEqual(sharedNamespaceId("fixture"), sharedNamespaceId("other"));
});
test("canonical namespace and profile validators refuse suffixes, Unicode and stale source pins", async () => {
  const f = await sharedDirectoryFixture();
  for (const bad of ["fixture\n", "fixture\r\n", "fixture\u2028", "Fixture", "fixture.", "xn--thing", "-a", "a-", "a".repeat(64)])
    assert.throws(() => canonicalTld(bad));
  for (const change of [{ communityKey: f.profile.communityKey + "\n" }, { registrySourceCommit: "84a120e42984050ec100a17286fae7e1bd843f31" },
    { namespaceId: "0x" + "f".repeat(64) }, { hostingOrigin: "https://community.example/" }, { installationId: "0x" + "0".repeat(64) }])
    assert.throws(() => validateSharedProfile({ ...f.profile, ...change }));
});
test("shared reader verifies immutable install/origin/namespace binding and current source code", async () => {
  const f = await sharedDirectoryFixture();
  assert.deepEqual(await f.read(), f.config);
  for (const fault of ["binding", "chain", "manifest", "state", "bytes", "reorg", "pretty", "duplicates"])
    await assert.rejects((await sharedDirectoryFixture(fault)).read());
});
test("configuration binds hosting origin independently from issuance namespace", async () => {
  const f = await sharedDirectoryFixture();
  assert.deepEqual(validateSharedConfig(f.config, f.profile), f.config);
  assert.equal(sharedBinding(f.profile).namespaceId, sharedNamespaceId(f.config.tld));
  for (const change of [{ installationId: "0x" + "a".repeat(64) }, { namespaceId: sharedNamespaceId("other") },
    { registry: "0x" + "7".repeat(40) }, { communityId: communityId(31337, f.profile.registry) }])
    assert.throws(() => validateSharedConfig({ ...f.config, ...change }, f.profile));
  const state = configurationState();
  validateSharedConfig(f.config, f.profile, state, 51n);
  assert.throws(() => validateSharedConfig({ ...f.config, configurationRevision: 2,
    app: { ...f.config.app, origin: "https://other.example" }, feed: { ...f.config.feed, endpoint: "https://other.example/api/feed" } },
    { ...f.profile, hostingOrigin: "https://other.example" }, state, 52n), /shared_binding_changed/);
});
test("explicit profile selection refuses every existing-installation implicit migration", async () => {
  const f = await sharedDirectoryFixture();
  assert.equal(selectSharedProfile(f.profile).releaseAccepted, false);
  assert.throws(() => selectSharedProfile(f.profile, { communityId: communityId(31337, f.profile.registry) }), /migration_required/);
  assert.throws(() => selectSharedProfile(f.profile, f.profile), /migration_required/);
});

test("profile JSON has exact canonical decimal block and complete commit/digest strings", async () => {
  const f = await sharedDirectoryFixture(), doc = sharedProfileDocument(f.profile);
  assert.deepEqual(parseSharedProfileDocument(doc), f.profile);
  for (const suffix of ["\n", "\r\n", "\u2028", "\u2029"])
    for (const key of ["deploymentBlock", "registrySourceCommit", "registryAbiSha256"] as const)
      assert.throws(() => parseSharedProfileDocument({ ...doc, [key]: doc[key] + suffix }));
  for (const block of ["050", "-1", "5e1", "0x32", 50])
    assert.throws(() => parseSharedProfileDocument({ ...doc, deploymentBlock: block }));
});

test("shared profile uses the same uncapped contiguous reader beyond revision 256", async () => {
  const f = await sharedDirectoryFixture();
  for (let i = 1; i < 260; i++) { f.state.head += 2n; await f.extend(); }
  const config = await f.read();
  assert.equal(config.configurationRevision, 260);
  assert.equal(config.schema, "pirate.community-config/2");
  assert.equal(config.communityId, f.profile.communityId);
});

test("more than 256 revisions in one canonical block are processed in log-index order without a lifetime cutoff", async () => {
  const f = await sharedDirectoryFixture();
  for (let i = 1; i < 260; i++) await f.extend();
  assert.equal((await f.read()).configurationRevision, 260);
  assert.ok(f.state.logRanges.some(([first, last]) => first === last));
});

test("namespace labels match registry Labels exactly at hyphen positions and canonical byte boundaries", () => {
  // Same explicit cases as the owning Solidity test; no registry source import.
  for (const value of ["a", "0", "a-b", "a--b", "ab-cd", "abc--d", "x-n", "a".repeat(63)]) {
    assert.equal(canonicalTld(value), value);
    assert.equal(sharedNamespaceId(value), keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }],
      [keccak256(stringToHex("pirate.namespace/1")), keccak256(stringToHex(value))])));
  }
  for (const value of ["", "ab--cd", "xn--thing", "a0--b", "12--3", "ab---c", "-a", "a-", "A", "a.b",
    "a_b", "é", "a\n", "a\r\n", "a\u2028", "a\u2029", "a".repeat(64)]) {
    assert.throws(() => canonicalTld(value), /invalid_shared_tld/);
    assert.throws(() => sharedNamespaceId(value), /invalid_shared_tld/);
  }
});
