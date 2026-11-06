import test from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog, sha256, toHex } from "viem";
import { canonical } from "../packages/community/common.ts";
import { v3Abi } from "../harness/reference-results/facts.ts";
import { referenceResults } from "../harness/reference-results/reduce.ts";
import { configurationDocument } from "../harness/reference-results/configuration.ts";
import { directoryAbi } from "../packages/community/directory-reader.ts";
import { studyTrace } from "./fixtures/reference-study.ts";
import {
  alterStudyPosts,
  alterStudyConfiguration,
  alterStudyLyrics,
  productionStudySourceAccepts,
} from "./fixtures/reference-study-source.ts";
const invalidPosts: [string, (post: any) => void][] = [
  [
    "rejected admission",
    (p) => {
      p.admission.decision = "reject";
    },
  ],
  [
    "registration content",
    (p) => {
      p.registration.contentSha256 = `0x${"e".repeat(64)}`;
    },
  ],
  [
    "lyrics media type",
    (p) => {
      p.media.find((m: any) => m.role === "lyrics").mediaType = "text/plain";
    },
  ],
  [
    "lyrics byte bound",
    (p) => {
      p.media.find((m: any) => m.role === "lyrics").byteLength = 1;
    },
  ],
  [
    "duplicate media role",
    (p) => {
      p.media.push({ ...p.media.find((m: any) => m.role === "audio") });
    },
  ],
  [
    "cover declaration",
    (p) => {
      p.admission.coverDisplayed = !p.admission.coverDisplayed;
    },
  ],
  [
    "unknown admission policy",
    (p) => {
      p.admission.policySha256 = `0x${"e".repeat(64)}`;
    },
  ],
  [
    "noncanonical registration token",
    (p) => {
      p.registration.tokenId = "01";
    },
  ],
  [
    "zero registration recipient",
    (p) => {
      p.registration.recipient = `0x${"0".repeat(40)}`;
    },
  ],
  [
    "supported admission policy from another configuration",
    (p) => {
      p.schema = "pirate.community-post/1";
      p.admission.policyVersion = "pirate-release/2026-08-29";
      p.admission.policySha256 =
        "0xf4355daa134e09599937e0547188046289fc598c089bc2ac1d381fb327e64e84";
      delete p.admission.automatedContent;
      delete p.admission.declarationSource;
    },
  ],
  [
    "extra post field",
    (p) => {
      p.unrecognized = true;
    },
  ],
];
for (const [name, mutate] of invalidPosts)
  test(
    "independent source refuses " +
      name +
      " with otherwise self-consistent publication hashes",
    async () => {
      const f = studyTrace();
      f.publish(5);
      alterStudyPosts(f, mutate);
      assert.equal(await productionStudySourceAccepts(f), false);
      const result = referenceResults(f.snapshot);
      assert.equal(result.records[0].verified, false);
      assert.deepEqual(result.days, []);
    },
  );
for (const [name, mutate] of [
  [
    "overlong valid language tag",
    (source: any) => {
      source.language = "en-abcdefgh-abcdefgh-abcdefgh-abcdefgh";
    },
  ],
  [
    "zero unselected occurrence identity",
    (source: any) => {
      source.lines[0].lineId = `0x${"0".repeat(64)}`;
    },
  ],
  [
    "unsupported lyric field",
    (source: any) => {
      source.extra = true;
    },
  ],
] as [string, (source: any) => void][])
  test(
    "independent source refuses " + name + " without using a favorable subset",
    async () => {
      const f = studyTrace();
      f.publish(5);
      alterStudyLyrics(f, mutate);
      assert.equal(await productionStudySourceAccepts(f), false);
      assert.deepEqual(referenceResults(f.snapshot).days, []);
    },
  );
test("canonical receipt copies bind every log position and block identity field", () => {
  for (const field of [
    "transactionIndex",
    "transactionHash",
    "blockHash",
    "blockNumber",
    "removed",
  ] as const) {
    const f = studyTrace();
    f.publish(5);
    const snapshot = JSON.parse(JSON.stringify(f.snapshot));
    const publication = snapshot.logs.find(
      (row: any) =>
        row.address === f.address &&
        decodeEventLog({ abi: v3Abi, data: row.data, topics: row.topics })
          .eventName === "ResultPublished",
    );
    assert.ok(publication);
    const receipt = snapshot.receipts[publication.transactionHash].logs.find(
      (row: any) => row.logIndex === publication.logIndex,
    );
    receipt[field] =
      field === "removed"
        ? true
        : field === "transactionIndex"
          ? 99
          : field === "blockNumber"
            ? "1"
            : `0x${"e".repeat(64)}`;
    assert.throws(() => referenceResults(snapshot), /receipt_log_mismatch/);
  }
});
test("supported configuration schemas reject unknown nested policy and app fields", () => {
  const f = studyTrace(),
    log = [...f.snapshot.logs]
      .reverse()
      .find(
        (row) =>
          row.address.toLowerCase() ===
          f.snapshot.profile.directory.address.toLowerCase(),
      )!;
  const event = decodeEventLog({
    abi: directoryAbi,
    eventName: "ConfigurationPublished",
    data: log.data,
    topics: log.topics,
  }).args;
  const config = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        Buffer.from(f.snapshot.documents[event.uri].slice(2), "hex"),
      ),
    ),
  );
  configurationDocument(config);
  for (const mutate of [
    (c: any) => {
      c.app.extra = true;
    },
    (c: any) => {
      c.policies.admission.sha256 = `0x${"e".repeat(64)}`;
    },
    (c: any) => {
      c.feed.endpoint += "/other";
    },
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.throws(() => configurationDocument(changed));
  }
  assert.equal(sha256(toHex(canonical(config))), event.sha256Digest);
});

test("a self-consistent latest configuration cannot rewrite the immutable community label", async () => {
  const f = studyTrace();
  f.publish(5);
  const config = alterStudyConfiguration(f, (config) => {
    config.tld = "different-community";
  });
  f.snapshot.directoryState.tldHash = sha256(toHex(config.tld));
  assert.equal(await productionStudySourceAccepts(f), false);
  assert.throws(
    () => referenceResults(f.snapshot),
    /configuration_tld_changed/,
  );
});
