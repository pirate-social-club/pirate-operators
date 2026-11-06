import test from "node:test";
import assert from "node:assert/strict";
import { firstResultsBoard } from "../harness/first-results-board.ts";
import { referenceResults } from "../harness/reference-results/reduce.ts";
import {
  publicCapture,
  trace,
  learner,
  timestamp,
} from "./fixtures/reference-results.ts";
import type { ReferenceSnapshot } from "../harness/reference-results/facts.ts";
import { abi, resultManifestUri } from "../harness/reference-results/facts.ts";
import {
  encodeEvent,
  rewritePublication,
  hash,
  epoch,
} from "./fixtures/reference-results.ts";
import { decodeEventLog, hexToBytes, keccak256, sha256, toHex } from "viem";
import { canonical } from "../packages/community/common.ts";
import { referenceBoards } from "../harness/reference-results/board.ts";
const clone = (s: ReferenceSnapshot) =>
  JSON.parse(JSON.stringify(s)) as ReferenceSnapshot;

async function agree(raw: ReferenceSnapshot) {
  const before = JSON.stringify(raw);
  const first = await firstResultsBoard(raw),
    second = referenceResults(raw);
  assert.equal(
    JSON.stringify(raw),
    before,
    "neither implementation may mutate the raw evidence",
  );
  assert.deepEqual(first, {
    rows: second.rows,
    days: second.days,
    scores: second.scores,
    outcomes: second.records
      .map((r) => ({
        key: r.key,
        revision: r.header.revision,
        commitment: r.commitment,
        completedAt: String(r.header.completedAt),
        policy: r.policy,
        status: r.status,
        verified: r.verified,
        lines: r.outcomes,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
  return second;
}
const community = (rows: any[]) =>
  rows.filter((r) => r.board.startsWith("community:"));

test("independent readers replay the retained public run without inventing a pre-policy day", async () => {
  const result = await agree(publicCapture());
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.verified, true);
  assert.equal(
    result.records[0]!.outcomes.filter((o) => o.status === 1).length,
    22,
  );
  assert.equal(
    result.records[0]!.outcomes.filter(
      (o) => o.status === 2 && o.grade === null,
    ).length,
    1,
  );
  assert.deepEqual(result.days, []);
  assert.equal(result.scores[0]!.scoreBps, 7800);
});

test("same-day retries deduplicate, tied ranks leave gaps, and ineligible learners retain history without a rank", async () => {
  const t = trace();
  const a = learner(1),
    b = learner(2),
    c = learner(3),
    d = learner(4);
  [a, b, c, d].forEach(t.enroll);
  t.publish(a, 5);
  t.publish(a, 5, 7000);
  t.publish(a, 6);
  t.publish(b, 5);
  t.publish(b, 6);
  t.publish(c, 6);
  t.publish(d, 5);
  t.append("EligibilityChanged", {
    learner: d,
    eligible: false,
    effectiveAt: BigInt(timestamp(6)),
    reasonCode: `0x${"1".repeat(64)}`,
  });
  const r = await agree(t.snapshot),
    rows = community(r.rows);
  const by = (who: string) =>
    rows.find((x) => x.learner === who.toLowerCase())!;
  assert.equal(by(a).days, 2);
  assert.equal(by(a).current, 2);
  assert.equal(by(a).best, 2);
  assert.equal(by(a).rank, 1);
  assert.equal(by(b).rank, 1);
  assert.equal(by(c).rank, 3);
  assert.equal(by(d).rank, null);
  assert.equal(by(d).days, 1);
});

test("correction repairs the original day/policy; invalidation and controller restoration never create duplicate days", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  const id = t.publish(a, 5, 6000);
  assert.deepEqual((await agree(t.snapshot)).rows, []);
  t.append("Revoked", {
    learner: a,
    enrollmentId: t.latest.get(id)!.header.enrollmentId,
    nonce: 1n,
  });
  t.addPolicy(6, { minScoreBps: 9500 });
  t.append(
    "EligibilityChanged",
    {
      learner: a,
      eligible: true,
      effectiveAt: BigInt(timestamp(6)),
      reasonCode: `0x${"2".repeat(64)}`,
    },
    timestamp(6),
  );
  t.correct(id, t.wire(8000));
  let r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.days, 1);
  assert.equal(r.days[0]!.period, 5);
  t.correct(id, t.latest.get(id)!.wire, 5);
  r = await agree(t.snapshot);
  assert.deepEqual(r.rows, []);
  assert.equal(
    r.scores[0]!.scoreBps,
    null,
    "invalidation removes active score, preserving raw grades",
  );
  assert.ok(r.records[0]!.outcomes.every((x) => x.grade === 8000));
  t.correct(id, t.wire(9000));
  r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.days, 1);
  assert.equal(r.records[0]!.header.qualificationPolicy, t.policyHash);
  assert.equal(r.records[0]!.header.revision, 4);
});

test("abandonment preserves assessed outcomes; unattempted stays in denominator and missing measurement remains null", async () => {
  const t = trace();
  const people = [1, 2, 3, 4, 5].map(learner);
  people.forEach(t.enroll);
  const unreached = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [i + 1, { status: 5 }]),
  );
  t.publish(people[0]!, 5, 10000, unreached, { status: 2 });
  t.publish(people[1]!, 5, 8000, { 1: { status: 4 }, 2: { status: 4 } });
  t.publish(people[2]!, 5, 10000, {
    1: { status: 4 },
    2: { status: 4 },
    3: { status: 4 },
  });
  t.publish(
    people[3]!,
    5,
    10000,
    Object.fromEntries(
      Array.from({ length: 23 }, (_, i) => [i + 1, { status: 4 }]),
    ),
  );
  t.publish(people[4]!, 5, 10000, {
    1: { status: 2 },
    2: { status: 3 },
    3: { status: 5 },
  });
  const r = await agree(t.snapshot);
  const expectedScores = [6086, 8000, 10000, null, 8695];
  people.forEach((who, i) => {
    const record = r.records.find((x) => x.learner === who.toLowerCase())!;
    assert.equal(
      r.scores.find((x) => x.key === record.key)!.scoreBps,
      expectedScores[i],
    );
  });
  const qualifying = community(r.rows)
    .map((x) => x.learner)
    .sort();
  assert.deepEqual(
    qualifying,
    [people[1]!.toLowerCase(), people[4]!.toLowerCase()].sort(),
  );
  const abandoned = r.records.find(
    (x) => x.learner === people[0]!.toLowerCase(),
  )!;
  assert.equal(abandoned.outcomes.filter((x) => x.status === 1).length, 14);
  assert.ok(
    abandoned.outcomes
      .filter((x) => x.status === 5)
      .every((x) => x.grade === null),
  );
  const failed = r.records.find((x) => x.learner === people[3]!.toLowerCase())!;
  assert.ok(failed.outcomes.every((x) => x.grade === null));
  assert.equal(r.scores.find((x) => x.key === failed.key)!.scoreBps, null);
});

test("an unavailable new policy cannot fall back to the previous policy", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  const policy = t.addPolicy(6);
  t.publish(a, 6, 10000, {}, { qualificationPolicy: policy.hash });
  delete t.snapshot.documents[policy.uri];
  const r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.days, 1);
  assert.deepEqual(
    r.days.map((x) => x.period),
    [5, 5],
  );
});

test("future eligibility and streak expiry use the supplied evaluation time without another result", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  t.publish(a, 6);
  t.append("EligibilityChanged", {
    learner: a,
    eligible: false,
    effectiveAt: BigInt(timestamp(7)),
    reasonCode: `0x${"3".repeat(64)}`,
  });
  let r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.rank, 1);
  t.snapshot.evaluationTimestamp = timestamp(7) + 1;
  r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.rank, null);
  assert.equal(community(r.rows)[0]!.current, 2);
  t.snapshot.evaluationTimestamp = timestamp(8);
  r = await agree(t.snapshot);
  assert.equal(community(r.rows)[0]!.current, 0);
  assert.equal(community(r.rows)[0]!.best, 2);
});

test("completion at 16:59:59 and 17:00:00 uses different learning days despite later publication", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  const boundary = epoch + 5 * 86400;
  t.publish(
    a,
    4,
    10000,
    {},
    { startedAt: BigInt(boundary - 11), completedAt: BigInt(boundary - 1) },
  );
  t.publish(
    a,
    5,
    10000,
    {},
    { startedAt: BigInt(boundary - 10), completedAt: BigInt(boundary) },
  );
  const r = await agree(t.snapshot);
  assert.deepEqual(r.records.map((r) => r.period).sort(), [4, 5]);
  assert.ok(r.days.every((d) => d.period === 5));
  assert.equal(community(r.rows)[0]!.days, 1);
});

test("a replaced chain suffix rebuilds from empty and cannot retain an orphaned qualifying day", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  assert.equal(community((await agree(t.snapshot)).rows)[0]!.days, 1);
  const changed = clone(t.snapshot);
  const log = rewritePublication(changed, (header) => ({
    header,
    wire: t.wire(6000),
  }));
  const nextHash = hash("synthetic-replacement-branch");
  changed.blocks[log.blockNumber]!.hash = nextHash;
  changed.head.hash = nextHash;
  changed.checkedHeadHash = nextHash;
  changed.logs
    .filter((l) => l.blockNumber === log.blockNumber)
    .forEach((l) => (l.blockHash = nextHash));
  const receipt = changed.receipts[log.transactionHash]!;
  receipt.blockHash = nextHash;
  receipt.logs.forEach((l) => (l.blockHash = nextHash));
  assert.deepEqual((await agree(changed)).rows, []);
  const raced = clone(changed);
  raced.checkedHeadHash = t.snapshot.head.hash;
  await assert.rejects(firstResultsBoard(raced), /snapshot_changed/);
  assert.throws(() => referenceResults(raced), /snapshot_reorganized/);
});

test("a shortened grader manifest cannot discard failed or unreached source lines", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  const changed = clone(t.snapshot),
    old = t.latest.values().next().value!;
  const uri = resultManifestUri(old.header.contentRevision);
  const document = JSON.parse(
    new TextDecoder().decode(hexToBytes(changed.documents[uri]!)),
  );
  document.lines = document.lines.slice(0, 22);
  document.segments = document.segments.slice(0, 22);
  const bytes = toHex(canonical(document)),
    revision = sha256(bytes);
  changed.documents[resultManifestUri(revision)] = bytes;
  const ordinals = new Uint8Array(44);
  const v = new DataView(ordinals.buffer);
  for (let i = 0; i < 22; i++) v.setUint16(i * 2, i + 1);
  rewritePublication(changed, (header) => ({
    header: {
      ...header,
      contentRevision: revision,
      linesTotal: 22,
      exercisesHash: keccak256(ordinals),
    },
    wire: t.wire().slice(0, 2 + 22 * 10) as `0x${string}`,
  }));
  const r = await agree(changed);
  assert.deepEqual(r.rows, []);
  assert.equal(r.records[0]!.verified, false);
  assert.match(r.records[0]!.problems.join(" "), /shortened_source_manifest/);
});

test("incomplete coverage is rejected even when its supplied commitment is internally consistent", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  const changed = clone(t.snapshot);
  rewritePublication(changed, (header, wire) => ({
    header,
    wire: wire.slice(0, -10) as `0x${string}`,
  }));
  const r = await agree(changed);
  assert.deepEqual(r.rows, []);
  assert.equal(r.records[0]!.verified, false);
  assert.match(r.records[0]!.problems.join(" "), /incomplete_outcomes/);
});

test("changed policy bytes cannot lower a threshold and retroactive activation is refused", async () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5, 6000);
  const altered = clone(t.snapshot);
  const log = altered.logs.find((l) => {
    if (l.address.toLowerCase() !== t.address.toLowerCase()) return false;
    return (
      decodeEventLog({ abi, data: l.data, topics: l.topics, strict: true })
        .eventName === "PolicyActivated"
    );
  })!;
  const event = decodeEventLog({
    abi,
    eventName: "PolicyActivated",
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const p = JSON.parse(
    new TextDecoder().decode(
      hexToBytes(altered.documents[event.args.policyURI]!),
    ),
  );
  p.minScoreBps = 0;
  altered.documents[event.args.policyURI] = toHex(canonical(p));
  assert.deepEqual((await agree(altered)).rows, []);
  const retro = clone(t.snapshot),
    target = retro.logs.find(
      (l) =>
        l.transactionHash === log.transactionHash &&
        l.logIndex === log.logIndex,
    )!;
  const packet = encodeEvent("PolicyActivated", {
    ...event.args,
    effectivePeriod: 4n,
  });
  Object.assign(target, packet);
  Object.assign(
    retro.receipts[target.transactionHash]!.logs.find(
      (l) => l.logIndex === target.logIndex,
    )!,
    packet,
  );
  await assert.rejects(firstResultsBoard(retro), /retroactive_policy/);
  assert.throws(() => referenceResults(retro), /retroactive_policy/);
});

test("independent SQL scope unit: five songs in one period earn one community day and five song days", () => {
  const t = trace(),
    a = learner(1);
  t.enroll(a);
  t.publish(a, 5);
  const decoded = referenceResults(t.snapshot),
    original = decoded.records[0]!;
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    ...original,
    key: `${original.key}:${i}`,
    song: hash(`synthetic-song-${i}`),
  }));
  const board = referenceBoards(
    sessions,
    decoded.policies,
    [],
    t.snapshot.evaluationTimestamp,
  );
  assert.equal(community(board.rows)[0]!.days, 1);
  assert.equal(
    board.rows.filter((r) => String(r.board).startsWith("song:")).length,
    5,
  );
  assert.ok(board.rows.every((r) => r.days === 1));
});
