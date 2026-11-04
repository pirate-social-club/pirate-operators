// Publication of learning records by the operator and their reconstruction by
// the independent reader (docs/learning-records-contract.md), on local anvil.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { encodeEventTopics, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { accounts } from "../harness/runtime.ts";
import { post } from "../harness/karaoke-client.ts";
import { PAYMENT_GRACE_S, songEndMs, type KaraokeManifest } from "../packages/protocol/payments.ts";
import { consentMessage, consentTypes, recordsAbi, type Consent } from "../packages/protocol/records.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import { readLearner } from "../packages/records/reader.ts";
import { community, startChain, stopChain, type Chain } from "./payments-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(18745);
});
after(async () => {
  await stopChain(evm);
});

type C = Awaited<ReturnType<typeof community>>;
type A = Awaited<ReturnType<C["attempt"]>>;

// The public manifest store the reader resolves from: an IPFS stand-in that
// the community's database never serves.
const manifests = new Map<Hex, KaraokeManifest>();
const read = async (attemptId: Hex) =>
  (
    await readLearner(
      { rpcUrl: evm.rpcUrl, records: evm.recordsContract, manifest: async (r) => manifests.get(r) },
      accounts[5].address,
    )
  ).find((attempt) => attempt.attemptId === attemptId);

async function start(c: C) {
  const a = await c.attempt();
  manifests.set(a.ticket.body.manifestSha256, a.manifest);
  return a;
}
/** Signs the consent the operator offered on the socket and sends it. */
async function consent(a: A, signer: PrivateKeyAccount = accounts[5]) {
  const offered = a.socket.ready.consent as { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; message: Consent };
  const signature = await signer.signTypedData({
    domain: offered.domain,
    types: consentTypes,
    primaryType: "Consent",
    message: consentMessage(offered.message),
  });
  a.socket.send({ type: "consent", signature });
  return a.socket.next();
}
async function payAll(c: C, a: A, skip: string[] = []) {
  for (const segment of a.manifest.segments) {
    if (skip.includes(segment.segmentId)) continue;
    const opens = a.start.body.startedAt + Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
    if (opens > c.now()) await c.at(opens);
    const signed = await c.purchase(a.session, a.ticket.body.ticketId, segment.segmentId, a.start);
    assert.equal(signed.status, 200, JSON.stringify(signed.value));
    const answer = await a.socket.pay(signed.value);
    assert.equal(answer.type, "paid", JSON.stringify(answer));
  }
}
async function finish(c: C, a: A, words: KaraokeRecognizedWord[] = c.sung(a.manifest)) {
  await c.at(a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) - 1);
  a.socket.send({ type: "words", words });
  a.socket.send({ type: "finish" });
  await c.at(c.now() + PAYMENT_GRACE_S);
  const result = await c.result(a.ticket.body.ticketId);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value.body;
}
const publication = async (c: C) =>
  (await c.state("operator", "publication:")).map((r) => r.value as { state: string; revision: number; reason?: string });
/** Raw event counts for one attempt, independent of the reader. */
async function eventCounts(attemptId: Hex) {
  const counts: Record<string, number> = {};
  for (const eventName of ["AttemptOpened", "LineAssessed", "AttemptCompleted"] as const) {
    const [topic] = encodeEventTopics({ abi: recordsAbi, eventName });
    const logs = (await evm.rpc("eth_getLogs", [
      { address: evm.recordsContract, fromBlock: "0x0", toBlock: "latest", topics: [topic, attemptId] },
    ])) as unknown[];
    counts[eventName] = logs.length;
  }
  return counts;
}

test("a consented performance is published, and the reader rebuilds it with the community gone", async () => {
  const c = await community(evm, "records-full");
  const a = await start(c);
  assert.equal((await consent(a)).type, "consented");
  // Line 2 unpaid, line 3 paid but silent, lines 1 and 4 sung.
  await payAll(c, a, ["seg-02"]);
  const result = await finish(c, a, c.sung(a.manifest, { lineIds: ["line-01", "line-04"] }));
  assert.deepEqual(result.lines.map((l) => l.status), ["assessed", "unpaid", "silent", "assessed"]);
  assert.deepEqual(await publication(c), [{ revision: 1, ordinals: [1, 2, 3, 4], state: "published" }]);

  // The community's D1 and the operator's state are gone before reading.
  await c.dispose();
  rmSync(c.runtime.persist, { recursive: true, force: true });

  const read1 = await read(result.attemptId);
  assert.ok(read1?.verified, JSON.stringify(read1?.problems));
  assert.deepEqual(read1.problems, []);
  assert.equal(read1.contentRevision, result.manifestSha256);
  assert.equal(read1.grader, accounts[2].address);
  const grade = read1.grade!;
  assert.deepEqual(
    grade.lines.map((l) => [l.lineId, l.status, l.scoreBps, l.revision]),
    result.lines.map((l) => [l.lineId, l.status, l.scoreBps, 1]),
  );
  assert.equal(grade.status, "completed");
  assert.equal(grade.completedAt, result.performanceEndedAt);
  assert.equal(grade.unmeasuredCount, result.unmeasuredCount);
  assert.equal(grade.rewardScoreBps, result.rewardScoreBps);
  assert.ok(grade.claimMatches);
  assert.equal(read1.completions.length, 1);
  assert.deepEqual(await eventCounts(result.attemptId), { AttemptOpened: 1, LineAssessed: 4, AttemptCompleted: 1 });
});

test("publication interrupted halfway resumes from the next line without duplicating any", async () => {
  const c = await community(evm, "records-interrupted");
  try {
    const a = await start(c);
    assert.equal((await consent(a)).type, "consented");
    await c.fault("operator", "fault:crash-before-line", 3);
    await payAll(c, a);
    const result = await finish(c, a);
    // Open and lines 1 and 2 are on chain; the attempt is not yet a grade.
    const partial = await read(result.attemptId);
    assert.deepEqual(partial?.lines.map((l) => l.ordinal), [1, 2]);
    assert.deepEqual([partial?.grade, partial?.uncoveredRecords], [null, 2]);
    assert.equal((await publication(c))[0].state, "pending");

    await c.at(c.now() + 1);
    const complete = await read(result.attemptId);
    assert.ok(complete?.verified, JSON.stringify(complete?.problems));
    assert.deepEqual(complete.grade?.lines.map((l) => l.revision), [1, 1, 1, 1]);
    assert.equal(complete.uncoveredRecords, 0);
    assert.equal(complete.grade?.rewardScoreBps, result.rewardScoreBps);
    assert.equal((await publication(c))[0].state, "published");
    assert.deepEqual(await eventCounts(result.attemptId), { AttemptOpened: 1, LineAssessed: 4, AttemptCompleted: 1 });
  } finally {
    await c.dispose();
  }
});

test("nothing is published without consent, and retried publication lands exactly once", async () => {
  const c = await community(evm, "records-retry");
  try {
    const a = await start(c);
    const refused = await consent(a, accounts[6]);
    assert.deepEqual([refused.type, refused.code], ["error", "invalid_consent"]);
    await payAll(c, a);
    const result = await finish(c, a);
    assert.equal(await read(result.attemptId), undefined);
    assert.deepEqual(await publication(c), []);

    // Consent may follow the attempt's end on the live socket. The first
    // record transaction is signed but never broadcast.
    await c.fault("operator", "fault:crash-before-broadcast", true);
    assert.equal((await consent(a)).type, "consented");
    await c.at(c.now() + 1);
    assert.equal(await read(result.attemptId), undefined);

    // Recovery, a result read and further ticks all retry the same intents.
    const recover = () => post(c.runtime.mf, "operator", "/recover", {});
    await Promise.all([recover(), recover(), c.result(a.ticket.body.ticketId)]);
    await c.at(c.now() + 1);
    await c.at(c.now() + 1);
    const published = await read(result.attemptId);
    assert.ok(published?.verified, JSON.stringify(published?.problems));
    assert.equal(published.completions.length, 1);
    assert.deepEqual(await eventCounts(result.attemptId), { AttemptOpened: 1, LineAssessed: 4, AttemptCompleted: 1 });
    const transactions = (await c.state("operator", "tx:")).map(
      (r) => r.value as { kind: string; mined: { status: string } | null },
    );
    assert.ok(transactions.every((t) => t.mined?.status === "success"), JSON.stringify(transactions));
    assert.deepEqual(
      transactions.filter((t) => t.kind.startsWith("record_")).map((t) => t.kind),
      ["record_open", "record_line", "record_line", "record_line", "record_line", "record_complete"],
    );
  } finally {
    await c.dispose();
  }
});

test("a correction after completion supersedes one line, and the reader recomputes every claim", async () => {
  const c = await community(evm, "records-correction");
  try {
    const a = await start(c);
    assert.equal((await consent(a)).type, "consented");
    await payAll(c, a);
    const result = await finish(c, a);
    assert.deepEqual(result.lines.map((l) => l.status), ["assessed", "assessed", "assessed", "assessed"]);

    const corrected = await post<{ revision: number; error?: string }>(c.runtime.mf, "operator", "/__correct", {
      ticketId: a.ticket.body.ticketId,
      lineId: "line-02",
      status: "unmeasured",
      scoreBps: null,
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.value));
    assert.equal(corrected.value.revision, 2);
    await c.at(c.now() + 1);
    const latest = (await c.result(a.ticket.body.ticketId)).value.body;
    assert.equal(latest.revision, 2);
    assert.equal(latest.unmeasuredCount, 1);

    const r = await read(result.attemptId);
    assert.ok(r?.verified, JSON.stringify(r?.problems));
    assert.equal(r.completions.length, 2);
    const [first, second] = r.completions;
    // The first completion still covers the original line 2; the second covers its correction.
    assert.deepEqual(first.lines.map((l) => [l.status, l.revision]), result.lines.map((l) => [l.status, 1]));
    assert.deepEqual(
      second.lines.map((l) => [l.status, l.revision]),
      [["assessed", 1], ["unmeasured", 2], ["assessed", 1], ["assessed", 1]],
    );
    assert.equal(second.completedAt, first.completedAt);
    assert.equal(second.unmeasuredCount, latest.unmeasuredCount);
    assert.equal(second.rewardScoreBps, latest.rewardScoreBps);
    assert.equal(r.grade?.revision, 2);

    // A false claim from the grader itself is recorded but not believed.
    await evm.write(
      evm.recordsContract,
      "LearningRecords",
      "completeAttempt",
      [
        result.attemptId,
        {
          completedAt: BigInt(result.performanceEndedAt),
          status: 1,
          unmeasuredCount: 0,
          hasRewardScore: true,
          rewardScoreBps: 10000,
        },
      ],
      2,
    );
    const claimed = await read(result.attemptId);
    assert.ok(claimed?.verified);
    assert.deepEqual(claimed.problems, ["claim_mismatch:3"]);
    assert.equal(claimed.grade?.revision, 3);
    assert.equal(claimed.grade?.claimMatches, false);
    assert.deepEqual(claimed.grade?.claim, { unmeasuredCount: 0, rewardScoreBps: 10000 });
    assert.equal(claimed.grade?.unmeasuredCount, latest.unmeasuredCount);
    assert.equal(claimed.grade?.rewardScoreBps, latest.rewardScoreBps);
  } finally {
    await c.dispose();
  }
});

test("the reader refuses records whose manifest is missing or does not match", async () => {
  const c = await community(evm, "records-manifest");
  try {
    const a = await start(c);
    assert.equal((await consent(a)).type, "consented");
    await payAll(c, a);
    const result = await finish(c, a);
    manifests.delete(a.ticket.body.manifestSha256);
    const missing = await read(result.attemptId);
    assert.deepEqual([missing?.verified, missing?.grade, missing?.problems], [false, null, ["manifest_unavailable"]]);
    const altered = structuredClone(a.manifest);
    altered.lines[0].lineVersion = 2;
    manifests.set(a.ticket.body.manifestSha256, altered);
    const mismatched = await read(result.attemptId);
    assert.deepEqual(mismatched?.problems, ["manifest_digest_mismatch"]);
    assert.equal(mismatched?.grade, null);
  } finally {
    await c.dispose();
  }
});

const opNonce = async (c: C) => (await c.state("operator", "op:nonce"))[0]?.value as number;

test("a failed nonce allocation rolls back, so the operator's queue never skips a nonce", async () => {
  const c = await community(evm, "records-allocation");
  try {
    const a = await start(c);
    await payAll(c, a);
    const result = await finish(c, a);
    const before = await opNonce(c);
    // The allocation fails after advancing the nonce, before its row and link are saved.
    await c.fault("operator", "fault:fail-allocation", true);
    assert.equal((await consent(a)).type, "consented");
    await c.at(c.now() + 1);
    assert.equal(await opNonce(c), before);
    assert.deepEqual(
      (await c.state("operator", "intent:record_open:")).map((r) => (r.value as { nonce: number | null }).nonce),
      [null],
    );
    assert.deepEqual(await c.state("operator", `tx:${String(before).padStart(10, "0")}`), []);

    await c.at(c.now() + 1);
    const published = await read(result.attemptId);
    assert.ok(published?.grade, JSON.stringify(published));
    assert.deepEqual(await eventCounts(result.attemptId), { AttemptOpened: 1, LineAssessed: 4, AttemptCompleted: 1 });
    const nonces = (await c.state("operator", "tx:")).map((r) => r.value as { nonce: number; mined: { status: string } | null });
    assert.ok(nonces.every((row, i) => row.nonce === nonces[0].nonce + i && row.mined?.status === "success"));
    const chainNonce = Number(BigInt((await evm.rpc("eth_getTransactionCount", [accounts[2].address, "latest"])) as string));
    assert.equal(chainNonce, await opNonce(c));
  } finally {
    await c.dispose();
  }
});

test("a delayed publisher cannot erase a correction saved after another publisher finished", async () => {
  // An RPC proxy that holds the first completion receipt until released.
  const completed = encodeEventTopics({ abi: recordsAbi, eventName: "AttemptCompleted" })[0];
  let armed = false;
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const proxy = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = await (
      await fetch(evm.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body })
    ).text();
    if (armed && JSON.parse(body).method === "eth_getTransactionReceipt") {
      const receipt = JSON.parse(text).result as { logs: { topics: Hex[] }[] } | null;
      if (receipt?.logs.some((log) => log.topics[0] === completed)) {
        armed = false;
        held();
        await released;
      }
    }
    res.setHeader("Content-Type", "application/json");
    res.end(text);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const port = (proxy.address() as { port: number }).port;
  const c = await community({ ...evm, rpcUrl: `http://127.0.0.1:${port}` }, "records-stale");
  try {
    const a = await start(c);
    assert.equal((await consent(a)).type, "consented");
    await payAll(c, a);
    await c.at(a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) - 1);
    a.socket.send({ type: "words", words: c.sung(a.manifest) });
    a.socket.send({ type: "finish" });

    // Publisher A finalizes and publishes, then waits on its completion receipt.
    armed = true;
    const first = c.at(c.now() + PAYMENT_GRACE_S);
    await holding;
    // Publisher B finds the completion mined and marks revision 1 published.
    assert.equal((await post(c.runtime.mf, "operator", "/recover", {})).status, 200);
    assert.deepEqual((await publication(c)).map((p) => [p.revision, p.state]), [[1, "published"]]);
    const corrected = await post<{ revision: number }>(c.runtime.mf, "operator", "/__correct", {
      ticketId: a.ticket.body.ticketId,
      lineId: "line-02",
      status: "unmeasured",
      scoreBps: null,
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.value));
    assert.deepEqual((await publication(c)).map((p) => [p.revision, p.state]), [[2, "pending"]]);

    // A resumes with revision 1 and must leave revision 2 pending.
    release();
    await first;
    assert.deepEqual((await publication(c)).map((p) => [p.revision, p.state]), [[2, "pending"]]);
    await c.at(c.now() + 1);
    assert.deepEqual((await publication(c)).map((p) => [p.revision, p.state]), [[2, "published"]]);
    const attemptId = (await c.result(a.ticket.body.ticketId)).value.body.attemptId;
    const r = await read(attemptId);
    assert.ok(r?.verified, JSON.stringify(r?.problems));
    assert.deepEqual(r.completions.map((x) => x.revision), [1, 2]);
    assert.deepEqual(r.grade?.lines.map((l) => [l.status, l.revision])[1], ["unmeasured", 2]);
  } finally {
    release();
    await c.dispose();
    await new Promise((resolve) => proxy.close(resolve));
  }
});
