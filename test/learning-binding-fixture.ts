import { zeroHash, type Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { fixtureManifest, sungWords } from "../harness/karaoke-fixture.ts";
import { digest, sign, type Ticket } from "../packages/protocol/index.ts";
import {
  enrollmentTypes,
  type Enrollment,
} from "../packages/protocol/learning-results.ts";
import { quoteIdOf } from "../packages/protocol/payments.ts";
import { resultBody, type Attempt } from "../services/karaoke-result.ts";
import { bindEnrollment } from "../services/learning-results.ts";
import {
  contractDomain,
  resultsTarget,
} from "../services/learning-contract.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import { operatorQuote } from "../services/purchases.ts";
import type { Env } from "../services/runtime.ts";

/** Explicit local contracts and JSON journal; no public network or provider. */
export async function learningBindingFixture(
  port: number,
  communityId = digest("binding-community"),
) {
  const evm = await chain(port);
  const publicityPolicy = digest("binding-publicity");
  const v2 = await evm.deploy("LearningResultsV2", [
    accounts[3].address,
    communityId,
    publicityPolicy,
  ]);
  const v3 = await evm.deploy("LearningResultsV3", [
    accounts[3].address,
    communityId,
    publicityPolicy,
  ]);
  await evm.write(
    v2,
    "LearningResultsV2",
    "setGrader",
    [accounts[2].address, 1, true],
    3,
  );
  await evm.write(
    v3,
    "LearningResultsV3",
    "setGrader",
    [accounts[2].address, 1, true],
    3,
  );
  let now = Number((await evm.publicClient.getBlock()).timestamp);
  let rows = new Map<string, unknown>();
  const store: ResultStore = {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: (key, value) => {
      rows.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: (key) => {
      rows.delete(key);
    },
    entries: (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T) => {
      const prior = new Map(rows);
      try {
        return fn();
      } catch (error) {
        rows = prior;
        throw error;
      }
    },
    now: () => now,
  };
  const env = {
    RPC_URL: evm.rpcUrl,
    PAYMENT_CHAIN_ID: "31337",
    RESULTS_V2_CONTRACT: v2,
    COMMUNITY_ID: communityId,
    OPERATOR_ADDRESS: accounts[2].address,
    PRIVATE_KEY: keys[2],
    SERVICE_MODE: "internal",
    SPONSOR_CAP_WEI: "1000000000000000000",
    SPONSOR_GAS_PRICE_WEI: "10000000000",
    SPONSOR_GAS_LIMIT: "2000000",
    SPONSOR_DATA_FEE_WEI: "0",
  } as Env;
  async function enrollment(version: 2 | 3, learner = 5) {
    const target = resultsTarget({ ...env, RESULTS_V3_CONTRACT: v3 }, version);
    const e: Enrollment = {
      learner: accounts[learner].address,
      communityId,
      activities: version === 3 ? 3n : 1n,
      publicityPolicy,
      expiresAt: BigInt(now + 86400),
      nonce: 0n,
    };
    const signature = await accounts[learner].signTypedData({
      domain: contractDomain(target),
      types: enrollmentTypes,
      primaryType: "Enrollment",
      message: e,
    });
    return { e, signature, target };
  }
  async function prepare(name: string) {
    now = Number((await evm.publicClient.getBlock()).timestamp);
    const manifest = fixtureManifest({
      communityId,
      audio: "0x01",
      lyrics: "fixture",
      title: "fixture",
      artwork: "fixture",
      original: true,
    });
    manifest.song = {
      chainId: 6343,
      posts: accounts[0].address,
      communityId,
      postId: digest("fixture-post"),
    };
    const quote = operatorQuote(env),
      ticketId = digest(name);
    const ticket: Ticket = {
      ticketId,
      participant: accounts[5].address,
      communityId,
      songHash: manifest.songHash,
      manifestSha256: digest(manifest),
      sessionKey: accounts[6].address,
      operator: accounts[2].address,
      quoteId: quoteIdOf(quote),
      community: accounts[3].address,
      mode: "performance",
      maxPaidSegments: 4,
      maxDurationMs: 27000,
      issuedAt: now,
      expiresAt: now + 100,
    };
    store.set(`ticket:${ticketId}`, await sign("ticket", ticket, keys[1]));
    store.set(`manifest:${ticket.manifestSha256}`, manifest);
    await bindEnrollment(env, store, ticketId, ticket.participant);
    return { ticket, manifest };
  }
  async function finish({
    ticket,
    manifest,
  }: Awaited<ReturnType<typeof prepare>>) {
    const attempt: Attempt = {
      ticketId: ticket.ticketId,
      attemptId: digest(ticket.ticketId),
      startedAt: ticket.issuedAt,
      connected: false,
      disconnectedAt: ticket.issuedAt + 6,
      lastAudioAt: ticket.issuedAt + 6,
      failedLineIds: [],
      ended: {
        endedAt: ticket.issuedAt + 36,
        performanceEndedAt: ticket.issuedAt + 6,
        status: "abandoned",
        paymentDeadline: ticket.issuedAt + 46,
      },
      closing: { block: null },
      finalized: true,
      generation: 1,
    };
    store.set(`words:${ticket.ticketId}`, sungWords(manifest));
    const quote = operatorQuote(env),
      result = resultBody(
        store,
        ticket,
        manifest,
        quote,
        quoteIdOf(quote),
        attempt,
        new Map(),
        0,
      );
    now = Math.max(now + 1, ticket.issuedAt + 50);
    await evm.rpc("evm_setNextBlockTimestamp", [now]);
    await evm.rpc("evm_mine", []);
    store.set(
      `result:${ticket.ticketId}`,
      await sign("result", result, keys[2]),
    );
    return result;
  }
  return {
    evm,
    env,
    store,
    v2,
    v3,
    zeroHash,
    enrollment,
    prepare,
    finish,
    restartJournal: () => {
      rows = new Map(JSON.parse(JSON.stringify([...rows])));
    },
    async stop() {
      evm.child.kill();
      await new Promise<void>((resolve) =>
        evm.child.exitCode !== null
          ? resolve()
          : evm.child.once("exit", () => resolve()),
      );
    },
  };
}
