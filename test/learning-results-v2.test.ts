import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToHex, zeroAddress, type Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { fixtureManifest, sungWords } from "../harness/karaoke-fixture.ts";
import { digest, sign, type Ticket } from "../packages/protocol/index.ts";
import { enrollmentIdOf, enrollmentTypes, orderedExercisesHash, packOutcomes, resultsDomain, unpackOutcomes } from "../packages/protocol/learning-results.ts";
import { quoteIdOf, verifyKaraokeResult } from "../packages/protocol/payments.ts";
import { resultBody, type Attempt } from "../services/karaoke-result.ts";
import { acceptEnrollment, bindEnrollment, publicationV2, publishV2 } from "../services/learning-results.ts";
import type { TxStore } from "../services/operator-tx.ts";
import type { Env } from "../services/runtime.ts";
import { operatorQuote } from "../services/purchases.ts";

test("compact encoding preserves missing measurements and the whole ordered denominator", () => {
  const lines = [ { status: "assessed" as const, scoreBps: 0 },
    ...(["silent", "unpaid", "unmeasured", "unattempted"] as const).map((status) => ({ status, scoreBps: null })) ];
  const packed = packOutcomes(lines);
  assert.equal(packed.length, 2 + 5 * 10);
  assert.deepEqual(unpackOutcomes(packed, 5).map(({ status, scoreBps }) => ({ status, scoreBps })), lines);
  assert.throws(() => unpackOutcomes(`0x0002${packed.slice(6)}`, 5), /invalid_grade/);
  assert.throws(() => packOutcomes([{ status: "unmeasured", scoreBps: 0 }]), /invalid_grade/);
  assert.notEqual(orderedExercisesHash(5), orderedExercisesHash(4));
});

test("internal Karaoke publishes one terminal bundle through the durable sender without purchases", { timeout: 60000 }, async () => {
  const evm = await chain(19345);
  try {
    const communityId = keccak256(stringToHex("v2-community")), publicityPolicy = keccak256(stringToHex("v2-publicity"));
    const contract = await evm.deploy("LearningResultsV2", [accounts[3].address, communityId, publicityPolicy]);
    await evm.write(contract, "LearningResultsV2", "setGrader", [accounts[2].address, 1, true], 3);
    let now = Number((await evm.publicClient.getBlock()).timestamp);
    const rows = new Map<string, unknown>();
    const store: TxStore & { now: () => number } = {
      get: <T>(key: string) => rows.get(key) as T | undefined,
      set: (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
      delete: (key) => { rows.delete(key); },
      entries: (prefix) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      transaction: <T>(fn: () => T) => { const prior = new Map(rows); try { return fn(); } catch (e) { rows.clear(); for (const [k, v] of prior) rows.set(k, v); throw e; } },
      now: () => now,
    };
    const env = { RPC_URL: evm.rpcUrl, PAYMENT_CHAIN_ID: "31337", RESULTS_V2_CONTRACT: contract,
      COMMUNITY_ID: communityId, OPERATOR_ADDRESS: accounts[2].address, PRIVATE_KEY: keys[2], SERVICE_MODE: "internal",
      SPONSOR_CAP_WEI: "100000000000000000", SPONSOR_GAS_PRICE_WEI: "10000000000", SPONSOR_GAS_LIMIT: "2000000", SPONSOR_DATA_FEE_WEI: "0" } as Env;
    const enrollment = { learner: accounts[5].address, communityId, activities: 1n, publicityPolicy, expiresAt: BigInt(now + 86400), nonce: 0n };
    const signature = await accounts[5].signTypedData({ domain: resultsDomain(31337, contract), types: enrollmentTypes, primaryType: "Enrollment", message: enrollment });
    assert.equal(await evm.read(contract, "LearningResultsV2", "enrollmentDigest", [enrollment]), enrollmentIdOf(31337, contract, enrollment));
    let enrolled = await acceptEnrollment(env, store, enrollment, signature);
    for (let i = 0; !enrolled?.mined && i < 5; i++) enrolled = await acceptEnrollment(env, store, enrollment, signature);
    assert.equal(enrolled?.mined?.status, "success");
    now = Number((await evm.publicClient.getBlock()).timestamp);
    const manifest = fixtureManifest({ communityId, audio: "0x01", lyrics: "fixture", title: "fixture", artwork: "fixture", original: true });
    manifest.song = { chainId: 6343, posts: accounts[0].address, communityId, postId: digest("fixture-post") };
    const quote = operatorQuote(env), ticketId = digest("v2-ticket");
    const ticket: Ticket = { ticketId, participant: accounts[5].address, communityId, songHash: manifest.songHash,
      manifestSha256: digest(manifest), sessionKey: accounts[6].address, operator: accounts[2].address,
      quoteId: quoteIdOf(quote), community: accounts[3].address, mode: "performance", maxPaidSegments: 4,
      maxDurationMs: 27000, issuedAt: now, expiresAt: now + 100 };
    store.set(`ticket:${ticketId}`, await sign("ticket", ticket, keys[1]));
    store.set(`manifest:${ticket.manifestSha256}`, manifest);
    await bindEnrollment(env, store, ticketId, ticket.participant);
    const attempt: Attempt = { ticketId, attemptId: digest(ticketId), startedAt: now, connected: false,
      disconnectedAt: now + 6, lastAudioAt: now + 6, failedLineIds: [], ended: { endedAt: now + 36,
        performanceEndedAt: now + 6, status: "abandoned", paymentDeadline: now + 46 },
      closing: { block: null }, finalized: true, generation: 1 };
    store.set(`words:${ticketId}`, sungWords(manifest));
    const result = resultBody(store, ticket, manifest, quote, quoteIdOf(quote), attempt, new Map(), 0);
    assert.equal(result.serviceMode, "internal"); assert.deepEqual(result.billing, []);
    assert.equal(result.paidAmount, "0"); assert.equal(result.lines[0].status, "assessed");
    assert.equal(result.lines[3].status, "unattempted");
    verifyKaraokeResult(result, manifest, quote);
    const { serviceMode: omitted, ...externalQuote } = quote;
    assert.throws(() => verifyKaraokeResult(result, manifest, externalQuote), /quote_mismatch/);
    await evm.rpc("evm_setNextBlockTimestamp", [now + 50]); await evm.rpc("evm_mine", []); now += 50;
    store.set(`result:${ticketId}`, await sign("result", result, keys[2]));
    for (let i = 0; i < 5 && publicationV2(store, ticketId)?.state !== "published"; i++) await publishV2(env, store, ticketId);
    assert.equal(publicationV2(store, ticketId)?.state, "published");
    assert.equal(store.entries("tx:").filter(({ value }) => (value as { kind: string }).kind === "record_result").length, 1);
    assert.equal(store.entries("intent:").some(({ value }) => ["redeem", "close"].includes((value as { kind: string }).kind)), false);
    assert.notEqual(await evm.read(contract, "LearningResultsV2", "commitments", [result.attemptId]), `0x${"00".repeat(32)}`);
    // A second call recovers the same intent instead of opening another transaction.
    await publishV2(env, store, ticketId);
    assert.equal(store.entries("tx:").length, 2); // enrollment + one result
  } finally {
    evm.child.kill();
    await new Promise<void>((resolve) => evm.child.exitCode !== null ? resolve() : evm.child.once("exit", () => resolve()));
  }
});
