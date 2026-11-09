import test from "node:test";
import assert from "node:assert/strict";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import { hexToBytes } from "viem";
import { hashJson, hashText, publicId } from "../packages/community/common.ts";
import {
  communityId,
  createLyrics,
  ipfsUri,
  quarantined,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  validateConfig,
  validateLyrics,
  validatePost,
  validatePostForEvent,
  type PublicationEvent,
} from "../packages/community/manifests.ts";
import {
  OWNER_POLICY_HASH,
  OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";

const addr = (n: string) => `0x${n.repeat(40)}` as const;
const cid = `ipfs://${CID.createV1(0x55, create(0x12, hexToBytes(hashText("public fixture")))).toString()}`;
const registry = addr("1"),
  postsContract = addr("2"),
  id = communityId(6343, registry),
  postId = publicId();
const identity = { chainId: 6343, postsContract, communityId: id, postId };
function config(revision = 1, publisher = addr("3")) {
  return {
    schema: "pirate.community-config/1",
    chainId: 6343,
    directory: addr("4"),
    communityId: id,
    registry,
    tld: "fixture",
    configurationRevision: revision,
    postsContract,
    controller: addr("5"),
    publisher,
    operatorPayments: addr("0"),
    learningRecords: addr("0"),
    app: {
      label: "app",
      tokenGeneration: "0",
      origin: "https://community.example",
      httpsAlias: null,
      hnsIngress: "none",
    },
    feed: {
      endpoint: "https://community.example/api/feed",
      signingKeyId: "fixture-key-v1",
    },
    policies: {
      admission: { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
      moderationSigner: addr("6"),
    },
    publisherRevocations: [] as {
      postsContract: string;
      publisher: string;
      fromBlock: string;
    }[],
  };
}
function post() {
  return {
    ...identity,
    schema: "pirate.community-post/1",
    authorId: publicId(),
    kind: "song",
    revision: 1,
    configurationRevision: 1,
    publishedAt: 1800000000,
    title: "Public fixture",
    language: "und",
    rating: "general",
    media: [
      {
        role: "audio",
        uri: cid,
        sha256: hashText("audio"),
        byteLength: 1000,
        mediaType: "audio/mpeg",
      },
    ],
    admission: {
      policyVersion: RELEASE_POLICY,
      policySha256: RELEASE_POLICY_HASH,
      decision: "publish",
      rating: "general",
      coverDisplayed: false,
      evidenceSha256: hashText("signed evidence"),
    },
    registration: {
      protocol: "story",
      network: "aeneid",
      chainId: 1315,
      assetId: addr("7"),
      nftContract: addr("8"),
      tokenId: "1",
      recipient: addr("9"),
      transactionHash: hashText("transaction"),
      blockHash: hashText("block"),
      blockNumber: "100",
      metadataUri: cid,
      metadataSha256: hashText("metadata"),
      contentSha256: hashText("audio"),
      status: "confirmed",
    },
  };
}
test("public manifests accept the frozen schemas and reject private or unrecognized metadata", () => {
  assert.throws(() => hashJson({ value: "\ud800" }), /invalid_unicode/);
  assert.throws(
    () => validatePost({ ...post(), title: "\udc00" }),
    /invalid_unicode/,
  );
  assert.equal(validateConfig(config()).communityId, id);
  assert.equal(
    (validatePost(post()).registration as { chainId: number }).chainId,
    1315,
  );
  assert.throws(
    () => validatePost({ ...post(), accountId: "private-account" }),
    /invalid_fields/,
  );
  assert.throws(
    () => validatePost({ ...post(), schema: "pirate.community-post/999" }),
    /unknown_schema/,
  );
  assert.throws(
    () => validateConfig({ ...config(), communityId: publicId() }),
    /community_identity_mismatch/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config(),
        app: { ...config().app, origin: "https://other.example" },
      }),
    /wrong_feed_origin/,
  );
  assert.throws(
    () =>
      validatePost({
        ...post(),
        admission: { ...post().admission, decision: "hold" },
      }),
    /invalid_admission_summary/,
  );
  assert.throws(
    () =>
      validatePost({
        ...post(),
        registration: {
          ...post().registration,
          contentSha256: hashText("different"),
        },
      }),
    /registration_content_mismatch/,
  );
});
test("IPFS references cannot select mutable HTTP URLs, query strings, traversal or unsupported CIDs", () => {
  assert.equal(ipfsUri(cid), cid);
  for (const value of [
    "https://attacker.example/content",
    cid + "?download=1",
    cid + "/../secret",
    cid + "#fragment",
    "ipfs://not-a-cid",
  ])
    assert.throws(() => ipfsUri(value));
});
test("a repeated chorus gets distinct stable occurrences and fake zero timings are rejected", () => {
  const lyrics = createLyrics(identity, "Chorus\nVerse\nChorus\n");
  assert.equal(lyrics.lines.length, 3);
  assert.notEqual(lyrics.lines[0]!.lineId, lyrics.lines[2]!.lineId);
  assert.deepEqual(validateLyrics(JSON.parse(JSON.stringify(lyrics))), lyrics);
  assert.throws(
    () =>
      validateLyrics({
        ...lyrics,
        lines: lyrics.lines.map((l) => ({ ...l, startMs: 0, endMs: 0 })),
      }),
    /invalid_fields/,
  );
  assert.throws(
    () =>
      validateLyrics({
        ...lyrics,
        lines: lyrics.lines.map((l) => ({
          ...l,
          lineId: lyrics.lines[0]!.lineId,
        })),
      }),
    /duplicate_lyric_occurrence/,
  );
  assert.throws(
    () => validateLyrics({ ...lyrics, sourceText: "Changed lyrics" }),
    /lyrics_hash_mismatch/,
  );
});
test("event validation prevents a valid manifest being replayed for another post or revision", () => {
  const p = validatePost(post()),
    c = validateConfig(config());
  const event: PublicationEvent = {
    ...identity,
    kind: 0,
    authorId: p.authorId,
    revision: 1,
    configurationRevision: 1,
    manifestSha256: hashJson(p),
    manifestURI: cid,
  };
  assert.equal(validatePostForEvent(p, event, c).postId, postId);
  assert.throws(
    () => validatePostForEvent(p, { ...event, kind: 1 }, c),
    /unsupported_post_event_kind/,
  );
  assert.throws(
    () =>
      validatePostForEvent(
        { ...p, title: "Altered after publication" },
        event,
        c,
      ),
    /post_manifest_hash_mismatch/,
  );
  assert.throws(
    () => validatePostForEvent(p, { ...event, postId: publicId() }, c),
    /post_event_identity_mismatch/,
  );
  assert.throws(
    () => validatePostForEvent(p, { ...event, revision: 2 }, c),
    /post_event_identity_mismatch/,
  );
});
test("publisher revocations are cumulative, inclusive and tied to historical configuration", () => {
  const c1 = validateConfig(config());
  const c2raw = config(2, addr("a"));
  c2raw.publisherRevocations = [
    { postsContract, publisher: c1.publisher, fromBlock: "100" },
  ];
  const c2 = validateConfig(c2raw, [c1], 105n);
  const p = validatePost(post());
  const event: PublicationEvent = {
    ...identity,
    kind: 0,
    authorId: p.authorId,
    revision: 1,
    configurationRevision: 1,
    manifestSha256: hashJson(p),
    manifestURI: cid,
  };
  assert.equal(quarantined(event, 99n, [c1, c2], c2), false);
  assert.equal(quarantined(event, 100n, [c1, c2], c2), true);
  const otherRegistry = addr("b"),
    otherId = communityId(6343, otherRegistry);
  const other1 = validateConfig({
    ...config(),
    registry: otherRegistry,
    communityId: otherId,
  });
  const other2 = validateConfig(
    { ...c2raw, registry: otherRegistry, communityId: otherId },
    [other1],
    105n,
  );
  assert.throws(
    () => quarantined(event, 100n, [c1, c2], other2),
    /revocation_configuration_mismatch/,
  );
  assert.throws(
    () => quarantined(event, 100n, [c1, c2], { ...c2, chainId: 31337 }),
    /revocation_configuration_mismatch/,
  );
  assert.throws(
    () =>
      quarantined(event, 100n, [c1, c2], { ...c2, postsContract: addr("d") }),
    /revocation_configuration_mismatch/,
  );
  assert.throws(
    () => validateConfig(config(3, addr("b")), [c1, c2], 200n),
    /revocation_removed_or_changed/,
  );
  assert.throws(
    () => validateConfig(config(3, addr("b")), [c1], 200n),
    /configuration_history_required/,
  );
  assert.throws(
    () => validateConfig({ ...c2raw, publisher: c1.publisher }, [c1], 105n),
    /publisher_is_revoked/,
  );
  assert.throws(
    () =>
      validateConfig(
        {
          ...c2raw,
          publisherRevocations: [
            { postsContract, publisher: addr("b"), fromBlock: "100" },
          ],
        },
        [c1],
        105n,
      ),
    /unknown_revoked_publisher/,
  );
  assert.throws(
    () =>
      validateConfig(
        {
          ...c2raw,
          publisherRevocations: [
            { postsContract, publisher: c1.publisher, fromBlock: "106" },
          ],
        },
        [c1],
        105n,
      ),
    /invalid_revocation_block/,
  );
});

function unregisteredPost() {
  const { registration: _receipt, ...rest } = post();
  return {
    ...rest,
    schema: "pirate.community-post/3",
    admission: {
      ...post().admission,
      policyVersion: UNREGISTERED_OWNER_POLICY_VERSION,
      policySha256: UNREGISTERED_OWNER_POLICY_HASH,
      automatedContent: "deferred",
      declarationSource: "operator_declared",
    },
    registration: { status: "absent", reason: "deferred_for_launch" },
  };
}
function unregisteredConfig() {
  const c = config();
  c.policies.admission = {
    version: UNREGISTERED_OWNER_POLICY_VERSION,
    sha256: UNREGISTERED_OWNER_POLICY_HASH,
  };
  return c;
}
test("the November 5 owner policy keeps its exact bytes and hash", () => {
  assert.equal(OWNER_POLICY_VERSION, "pirate-owner-curated/2026-11-05/1");
  assert.equal(
    OWNER_POLICY_HASH,
    "0xeac6c5663b1942264851404e8a713b43eb222335338a8f68a2d09ad083b26d97",
  );
  assert.notEqual(UNREGISTERED_OWNER_POLICY_HASH, OWNER_POLICY_HASH);
});
test("pirate.community-post/3 records registration as absent and nothing else", () => {
  const p = validatePost(unregisteredPost());
  assert.equal(p.schema, "pirate.community-post/3");
  assert.deepEqual(p.registration, {
    status: "absent",
    reason: "deferred_for_launch",
  });
  assert.equal(p.admission.declarationSource, "operator_declared");
  assert.equal(validatePost(JSON.parse(JSON.stringify(p))).postId, postId);
  // A fabricated or pending receipt cannot ride along with an absent registration.
  assert.throws(
    () =>
      validatePost({
        ...unregisteredPost(),
        registration: { ...post().registration },
      }),
    /invalid_fields/,
  );
  assert.throws(
    () =>
      validatePost({
        ...unregisteredPost(),
        registration: {
          status: "absent",
          reason: "deferred_for_launch",
          transactionHash: hashText("invented"),
        },
      }),
    /invalid_fields/,
  );
  assert.throws(
    () =>
      validatePost({
        ...unregisteredPost(),
        registration: { status: "pending", reason: "deferred_for_launch" },
      }),
    /invalid_absent_registration/,
  );
  // /3 binds the new owner policy; it cannot claim the registered owner policy.
  assert.throws(
    () =>
      validatePost({
        ...unregisteredPost(),
        admission: {
          ...unregisteredPost().admission,
          policyVersion: OWNER_POLICY_VERSION,
          policySha256: OWNER_POLICY_HASH,
        },
      }),
    /invalid_admission_summary/,
  );
  assert.throws(
    () =>
      validatePost({
        ...unregisteredPost(),
        admission: {
          ...unregisteredPost().admission,
          automatedContent: undefined,
        },
      }),
    /invalid_admission_summary|invalid_fields/,
  );
});
test("older schemas keep strict confirmed receipts and cannot declare absence", () => {
  for (const schema of ["pirate.community-post/1", "pirate.community-post/2"])
    assert.throws(
      () =>
        validatePost({
          ...post(),
          schema,
          registration: { status: "absent", reason: "deferred_for_launch" },
        }),
      /invalid_fields|invalid_admission_summary/,
    );
});
test("readers pair /3 only with the unregistered owner policy configuration", () => {
  const c3 = validateConfig(unregisteredConfig()),
    c1 = validateConfig(config()),
    p3 = validatePost(unregisteredPost()),
    p1 = validatePost(post());
  const event = (p: { authorId: `0x${string}` }, manifest: unknown) => ({
    ...identity,
    kind: 0 as const,
    authorId: p.authorId,
    revision: 1,
    configurationRevision: 1,
    manifestSha256: hashJson(manifest),
    manifestURI: cid,
  });
  assert.equal(
    validatePostForEvent(p3, event(p3, p3), c3).schema,
    "pirate.community-post/3",
  );
  assert.equal(
    validatePostForEvent(p1, event(p1, p1), c1).schema,
    "pirate.community-post/1",
  );
  assert.throws(
    () => validatePostForEvent(p3, event(p3, p3), c1),
    /post_admission_policy_mismatch/,
  );
  assert.throws(
    () => validatePostForEvent(p1, event(p1, p1), c3),
    /post_admission_policy_mismatch/,
  );
});
