import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { CommunityError, hashJson } from "../packages/community/common.ts";
import { danceVerdictsAbi as legacyAbi } from "../packages/dance-chain/abi.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import { rewardDanceV2Reader } from "../services/reward-dance-v2-reader.ts";
import { accountA, accountB, address, rewardDanceV2Fixture, word } from "./fixtures/reward-dance-v2.ts";

const denied = (code: string) => (e: unknown) => e instanceof CommunityError && e.code === code;
const read = (f: ReturnType<typeof rewardDanceV2Fixture>) =>
  rewardDanceV2Reader(f).read(f.offer, f.inputHash, f.fromBlock, f.cutoff);

test("current V2 receipt + registration + retained private UUID qualify once in milliseconds", async () => {
  const f = rewardDanceV2Fixture(), event = f.add(), reader = rewardDanceV2Reader(f);
  const policy = await reader.verifyAt(f.cutoff), entries = await read(f);
  assert.match(policy, /^0x[0-9a-f]{64}$/);
  assert.equal(await reader.verifyAt(f.cutoff), policy);
  assert.equal(reader.fromBlock, f.source.pin.deploymentBlock);
  assert.deepEqual(entries.map(({ evidenceHash, ...entry }) => entry), [{ accountId: accountA,
    wallet: event.capture.learner.toLowerCase(), completedAt: Number(event.verdict.committedAtSeconds * 1000n) }]);
  assert.match(entries[0].evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.equal((await read(f))[0].evidenceHash, entries[0].evidenceHash);
  assert.deepEqual(f.state.proofReads.sort(), ["capture", "capture", "song", "song"]);
  assert.ok(!f.state.reads.some(x => /send|sign|grantOf|checkGrant|reviewerRoles|identity/i.test(x)));
});

test("V2 sources are explicit per offer; legacy and other-source offers are never silently upgraded", async () => {
  for (const resultSources of [undefined, [word(999)]]) {
    const f = rewardDanceV2Fixture(); f.add();
    if (resultSources === undefined) delete f.offer.resultSources;
    else f.offer.resultSources = resultSources;
    assert.equal(Object.hasOwn(f.offer, "resultSources"), resultSources !== undefined);
    assert.deepEqual(await rewardDanceV2Reader(f).read(f.offer, hashJson(f.offer), f.fromBlock, f.cutoff), []);
    assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.proofReads, []);
  }
});

test("mutated offer attachment or input digest fails before public or private reads", async () => {
  const f = rewardDanceV2Fixture(); f.add(); f.offer.ticketIds.push("another-ticket");
  await assert.rejects(read(f), denied("reward_offer_input_changed"));
  assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.proofReads, []);
});

for (const [name, change] of [
  ["offer ID", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.offer.offerIdCommitment = word(990); } }); }],
  ["offer input", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.offer.inputHash = word(990); } }); }],
  ["offer source", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.offer.sourceHash = word(990); } }); }],
  ["offer window", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.offer.opensAtMs -= 1000n; } }); }],
  ["song ID", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.song.postId = word(990); } }); }],
  ["not passed", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ category: 2 }); }],
  ["absent offer", (f: ReturnType<typeof rewardDanceV2Fixture>) => { f.add({ changeCapture: c => { c.offer = { present: false, offerIdCommitment: word(0), inputHash: word(0), sourceHash: word(0), opensAtMs: 0n, cutoffAtMs: 0n }; } }); }],
] as const) test(`canonical V2 ${name} from another eligibility context yields no entry`, async () => {
  const f = rewardDanceV2Fixture(); change(f);
  assert.deepEqual(await read(f), []); assert.deepEqual(f.state.proofReads, []);
});

test("earliest private account result wins independent of RPC order", async () => {
  const f = rewardDanceV2Fixture();
  f.add({ block: 14n });
  const early = f.add({ block: 12n });
  f.add({ block: 13n, accountId: accountB, wallet: address(23) });
  const first = await read(f); f.events.reverse();
  assert.deepEqual(await read(f), first);
  assert.deepEqual(first.map(e => [e.accountId, e.wallet, e.completedAt]), [
    [accountA, early.capture.learner.toLowerCase(), Number((f.baseS + 1n) * 1000n)],
    [accountB, address(23), Number((f.baseS + 2n) * 1000n)],
  ]);
});

test("dedup never hides conflicting captured wallets from the ledger's account binding guard", async () => {
  const f = rewardDanceV2Fixture(); f.add(); f.add({ block: 13n, wallet: address(22) });
  await assert.rejects(read(f), denied("reward_qualifier_wallet_changed"));
});

test("offer opens inclusively and closes exclusively using canonical verdict time", async () => {
  const f = rewardDanceV2Fixture();
  const first = f.add({ block: 11n }); f.add({ block: 16n, accountId: accountB, wallet: address(23) });
  assert.deepEqual((await read(f)).map(e => [e.accountId, e.completedAt]), [
    [accountA, Number(first.verdict.committedAtSeconds * 1000n)],
  ]);
});

test("same-time dedup uses stable evidence identity rather than arrival order", async () => {
  const f = rewardDanceV2Fixture(); f.add(); f.add();
  const a = await read(f); f.events.reverse();
  assert.deepEqual(await read(f), a); assert.equal(a.length, 1);
});

for (const kind of ["missing", "foreign UUID", "public wallet ID", "mutated retained capture"] as const)
  test(`retained account ${kind} fails closed instead of consulting current credentials`, async () => {
    const f = rewardDanceV2Fixture(), e = f.add(), retained = f.retained.get(e.capture.captureId)!;
    if (kind === "missing") f.retained.clear();
    if (kind === "foreign UUID") retained.accountId = accountB;
    if (kind === "public wallet ID") retained.accountId = e.capture.learner;
    if (kind === "mutated retained capture") retained.capture.publicationGrantId = word(989);
    await assert.rejects(read(f), denied("dance_v2_retained_capture_unverified"));
  });

test("historical song verification includes exact revision and audio; unavailable proof never partially publishes", async () => {
  const f = rewardDanceV2Fixture(); f.add(); f.state.songVerified = false;
  await assert.rejects(read(f), denied("dance_historical_song_unverified"));
  const other = rewardDanceV2Fixture(); other.add({ changeCapture: c => { c.song.audioSha256 = word(989); } });
  await assert.rejects(read(other), denied("dance_historical_song_unverified"));
});

for (const kind of ["removed", "foreign emitter", "receipt bytes", "receipt owner", "reverted", "transaction position", "duplicate"] as const)
  test(`canonical V2 provenance rejects ${kind}`, async () => {
    const f = rewardDanceV2Fixture(), e = f.add();
    if (kind === "removed") e.log.removed = true;
    if (kind === "foreign emitter") e.log.address = address(991);
    if (kind === "receipt bytes") e.receipt.logs[0].data = `${e.log.data}00`;
    if (kind === "receipt owner") e.receipt.blockHash = word(991);
    if (kind === "reverted") e.receipt.status = "0x0";
    if (kind === "transaction position") f.blocks.get(e.log.blockNumber)!.transactions[0] = word(991);
    if (kind === "duplicate") f.events.push(e);
    const code = {
      removed: "dance_log_position_invalid", "foreign emitter": "dance_log_position_invalid",
      "receipt bytes": "dance_receipt_log_not_owned", "receipt owner": "dance_receipt_not_owned",
      reverted: "dance_receipt_not_owned", "transaction position": "dance_verdict_reorged",
      duplicate: "dance_duplicate_verdict_log",
    }[kind];
    await assert.rejects(read(f), denied(code));
  });

test("legacy V1 topic is not decoded as a V2 verdict, even with matching receipt-owned bytes", async () => {
  const f = rewardDanceV2Fixture(), e = f.add();
  e.log.topics[0] = encodeEventTopics({ abi: legacyAbi, eventName: "VerdictCommitted" })[0] as `0x${string}`;
  e.receipt.logs = [structuredClone(e.log)];
  await assert.rejects(read(f), denied("dance_v2_event_encoding_invalid"));
});

for (const kind of ["trailing registration", "submission mismatch", "event time", "window flag", "grant ID", "event trailing bytes"] as const)
  test(`V2 preimage and event binding rejects ${kind}`, async () => {
    const f = rewardDanceV2Fixture(), e = f.add();
    if (kind === "trailing registration") e.registration[0] = `${e.registration[0]}${"00".repeat(32)}`;
    if (kind === "submission mismatch") e.registration[2] = word(998);
    if (kind === "event time") { e.verdict.committedAtSeconds++; e.encodeEvent(); }
    if (kind === "window flag") { e.verdict.withinFrozenOfferWindow = false; e.encodeEvent(); }
    if (kind === "grant ID") { e.capture.publicationGrantId = word(998); e.encodeEvent(); }
    if (kind === "event trailing bytes") {
      e.log.data = `${e.log.data}${"00".repeat(32)}`; e.receipt.logs = [structuredClone(e.log)];
    }
    if (kind === "trailing registration") {
      await assert.rejects(read(f), { message: "dance_registration_preimage_mismatch" });
    } else {
      const code = {
        "submission mismatch": "dance_registration_hash_changed", "event time": "dance_event_context_changed",
        "window flag": "dance_verdict_binding_changed", "grant ID": "dance_verdict_binding_changed",
        "event trailing bytes": "dance_v2_event_encoding_invalid",
      }[kind];
      await assert.rejects(read(f), denied(code));
    }
  });

for (const kind of ["wrong chain", "V1 source", "source hash", "peer code", "unsafe cutoff", "changed cutoff", "incomplete cutoff", "late start"] as const)
  test(`V2 source/canonical scan refuses ${kind}`, async () => {
    const f = rewardDanceV2Fixture(); f.add();
    const originalCutoff = structuredClone(f.cutoff);
    let requestedCutoff: typeof f.cutoff = f.cutoff;
    if (kind === "wrong chain") f.state.chainId = 84532;
    if (kind === "V1 source") f.state.version = 1;
    if (kind === "source hash") f.state.sourceHash = word(995);
    if (kind === "peer code") f.state.codes.set(f.source.pin.consentRegistry, "0x6001");
    if (kind === "unsafe cutoff") f.state.safeNumber = 14n;
    if (kind === "changed cutoff") f.blocks.get(15n)!.hash = word(995);
    if (kind === "incomplete cutoff") {
      const block = f.blocks.get(14n)!;
      requestedCutoff = Object.freeze({ number: block.number, hash: block.hash, timestamp: block.timestamp });
    }
    if (kind === "late start") f.fromBlock = 13n;
    const code = {
      "wrong chain": "dance_wrong_chain", "V1 source": "dance_v2_historical_runtime_changed",
      "source hash": "dance_v2_historical_runtime_changed", "peer code": "dance_v2_historical_runtime_changed",
      "unsafe cutoff": "dance_verdict_not_confirmed", "changed cutoff": "reward_results_head_changed",
      "incomplete cutoff": "reward_cutoff_not_indexable", "late start": "reward_history_starts_after_offer",
    }[kind];
    await assert.rejects(rewardDanceV2Reader(f).read(f.offer, f.inputHash, f.fromBlock, requestedCutoff), denied(code));
    assert.deepEqual(f.cutoff, originalCutoff);
    assert.equal(Object.isFrozen(f.cutoff), true);
  });

test("cutoff reorg during historical proof reads rejects the entire result", async () => {
  const f = rewardDanceV2Fixture(); f.add();
  const originalCutoff = structuredClone(f.cutoff);
  const original = f.proofs.authenticateSong;
  f.proofs.authenticateSong = async (...args) => {
    const valid = await original(...args); f.blocks.get(f.cutoff.number)!.hash = word(996); return valid;
  };
  await assert.rejects(read(f), denied("reward_results_head_changed"));
  assert.deepEqual(f.cutoff, originalCutoff);
  assert.equal(Object.isFrozen(f.cutoff), true);
});

test("malformed canonical registration is rejected, not converted into a scored result", async () => {
  const f = rewardDanceV2Fixture(), e = f.add();
  e.submission.captureHash = word(997);
  e.registration[1] = encodeAbiParameters([danceShapes.submission], [e.submission]);
  await assert.rejects(read(f), { message: "dance_registration_preimage_mismatch" });
});

test("historical qualification reads only retained bindings, with no current authority or financial calls", async () => {
  const f = rewardDanceV2Fixture(); f.add();
  const before = structuredClone([...f.retained]);
  f.state.onRead = method => { assert.ok(!/send|sign/.test(method)); };
  assert.equal((await read(f)).length, 1);
  assert.deepEqual([...f.retained], before);
  assert.ok(!f.state.reads.some(x => /grantOf|checkGrant|account|identity|reviewerRoles/i.test(x)));
});

test("a missing retained binding in a later result rejects the whole batch", async () => {
  const f = rewardDanceV2Fixture(); f.add();
  const other = f.add({ accountId: accountB, wallet: address(23), block: 13n });
  f.retained.delete(other.capture.captureId);
  await assert.rejects(read(f), denied("dance_v2_retained_capture_unverified"));
});

test("an offer object changed during a public read cannot retarget the captured request", async () => {
  const f = rewardDanceV2Fixture(); f.add();
  const reader = rewardDanceV2Reader(f);
  let changed = false;
  f.state.onRead = () => {
    if (!changed) { changed = true; f.offer.songKey = word(994); f.offer.resultSources = []; }
  };
  const entries = await reader.read(f.offer, f.inputHash, f.fromBlock, f.cutoff);
  assert.equal(entries.length, 1); assert.equal(entries[0].accountId, accountA);
});

test("policy evidence itself fails closed on historical peer replacement", async () => {
  const f = rewardDanceV2Fixture(); f.state.codes.set(f.source.capturePolicy, "0x6001");
  await assert.rejects(rewardDanceV2Reader(f).verifyAt(f.cutoff), denied("dance_v2_historical_runtime_changed"));
});
