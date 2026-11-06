import test from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog } from "viem";
import { captureReference } from "../harness/reference-results/capture.ts";
import { evidenceClient } from "../harness/public-evidence-client.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { studySourceAuthenticator } from "../packages/records/study-source-authentication.ts";
import { referenceResults } from "../harness/reference-results/reduce.ts";
import { v3Abi } from "../harness/reference-results/facts.ts";
import { largeStudyTrace } from "./fixtures/reference-study-large.ts";
import { studyTrace } from "./fixtures/reference-study.ts";
import { reducePublicResultsV3 } from "../packages/records/results-v3.ts";
import { qualifiesStudyResult } from "../packages/records/study-qualification.ts";
const communityRows = (r: ReturnType<typeof referenceResults>) =>
  r.rows.filter((row) => String(row.board).startsWith("community:"));

test("independent raw V3 history shares a community day with Karaoke and keeps Study policy separate", async () => {
  const f = studyTrace();
  f.publishLegacy(5);
  f.publish(5);
  f.publish(6);
  const before = JSON.stringify(f.snapshot),
    r = referenceResults(f.snapshot);
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.equal(r.records.length, 3);
  assert.deepEqual(
    r.records.flatMap((record) => record.problems),
    [],
  );
  assert.equal(communityRows(r)[0].days, 2);
  assert.equal(communityRows(r)[0].current, 2);
  assert.equal(
    r.policies.filter((policy) => policy.contract.endsWith(f.address)).length,
    2,
  );
  const publications = f.snapshot.logs
    .filter((log) => log.address === f.address)
    .flatMap((log) => {
      const decoded = decodeEventLog({
        abi: v3Abi,
        data: log.data,
        topics: log.topics,
      });
      return decoded.eventName === "ResultPublished"
        ? [
            {
              ...decoded.args,
              blockNumber: BigInt(log.blockNumber),
              logIndex: log.logIndex,
            },
          ]
        : [];
    });
  const p = f.snapshot.profile,
    { client, transport } = evidenceClient(f.snapshot);
  const history = await readConfigurationHistory(
    client,
    {
      chainId: p.chainId,
      directory: p.directory.address,
      registry: p.registry,
      communityId: p.communityId,
      deploymentBlock: BigInt(p.directory.fromBlock),
      directoryCodeHash: p.directory.codeHash,
    },
    transport,
  );
  const authenticateStudy = studySourceAuthenticator({
    client,
    transport,
    head: BigInt(f.snapshot.head.number),
    history,
    posts: {
      address: p.posts.address,
      deploymentBlock: BigInt(p.posts.fromBlock),
      runtimeCodeHash: p.posts.codeHash,
    },
  });
  const first = await reducePublicResultsV3(publications, {
    communityId: f.snapshot.profile.communityId,
    studyManifest: async () => f.source,
    authenticateStudy,
  });
  assert.equal(first.length, 2);
  assert.ok(
    first.every(
      (result) =>
        result.verified &&
        qualifiesStudyResult(result, new Map([[f.policyHash, f.policy]]), 6n),
    ),
  );
});
test("independent Study corrections after revocation repair the original day and invalidation never falls back", () => {
  const f = studyTrace(),
    id = f.publish(5, [false, false, true, true]);
  assert.deepEqual(communityRows(referenceResults(f.snapshot)), []);
  f.revoke();
  f.correct(id);
  let r = referenceResults(f.snapshot);
  assert.equal(communityRows(r)[0].days, 1);
  assert.equal(r.days[0].period, 5);
  f.correct(id, undefined, 5);
  r = referenceResults(f.snapshot);
  assert.deepEqual(r.days, []);
  assert.equal(r.records[0].status, 5);
  assert.equal(r.records[0].verified, false);
  f.correct(id);
  r = referenceResults(f.snapshot);
  assert.equal(r.records[0].header.revision, 4);
  assert.equal(communityRows(r)[0].days, 1);
});
test("independent Study absence is not incorrect and a partial high score earns no qualifying day", () => {
  const f = studyTrace();
  f.publish(5, [true, true, true, true], 2, "unmeasured");
  const r = referenceResults(f.snapshot),
    record = r.records[0];
  assert.equal(record.verified, true);
  assert.equal(record.outcomes[0].status, 4);
  assert.equal(record.outcomes[0].grade, null);
  assert.equal(r.scores[0].scoreBps, null);
  assert.deepEqual(r.days, []);
});
test("a malformed latest Study revision cannot revive its earlier qualifying result", () => {
  const f = studyTrace(),
    id = f.publish(5);
  f.correct(id, [false, false, true, true]);
  const log = [...f.snapshot.logs]
    .reverse()
    .find(
      (log) =>
        log.address === f.address &&
        decodeEventLog({ abi: v3Abi, data: log.data, topics: log.topics })
          .eventName === "ResultPublished",
    )!;
  f.snapshot.receipts[log.transactionHash].status = "reverted";
  assert.throws(() => referenceResults(f.snapshot), /noncanonical/);
});

test("public-only capture replays V3 activity policies and large-source media URIs without raw-CID guesses", async () => {
  const f = await largeStudyTrace();
  f.publishLegacy(5);
  f.publish(5);
  const { client, transport } = evidenceClient(f.snapshot);
  const captured = await captureReference(
    client,
    f.snapshot.profile,
    BigInt(f.snapshot.head.number),
    f.snapshot.evaluationTimestamp,
    transport,
  );
  assert.ok(captured.documents[f.sourceUri!]);
  const actual = referenceResults(captured),
    expected = referenceResults(f.snapshot);
  assert.deepEqual(actual.rows, expected.rows);
  assert.deepEqual(actual.days, expected.days);
  assert.deepEqual(actual.scores, expected.scores);
  assert.equal(
    captured.contractStates.find((state) => state.address === f.address)
      ?.version,
    3,
  );
  assert.equal(
    captured.contractStates.find((state) => state.address === f.address)
      ?.policies["2:5"],
    f.policyHash,
  );
});
