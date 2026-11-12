// Repair2 prepared regressions. UNRUN. Actual resume/erasure/SQLite Store with
// explicit deferred JSON-RPC; no Worker, socket, provider or chain is started.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeFunctionData,
  zeroHash,
  keccak256,
  type Hex,
} from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultCommitment,
  packStudyOutcomes,
  type TerminalResult,
} from "../packages/protocol/learning-results-v3.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import {
  resumeStudyPublication,
  type PublicationJob,
} from "../services/study-publication.ts";
import {
  reserveSponsorship,
  chargeSponsorship,
  sponsorLimits,
} from "../services/sponsor-budget.ts";
import { enqueue, intentOf } from "../services/operator-tx.ts";
import { stageLinkedWithdrawal } from "../services/study-linked-withdrawal.ts";
import { LinkedWithdrawalPending } from "../services/study-linked-withdrawal-contract.ts";
import {
  linkedFixture,
  boot,
  scope,
  target,
  communityId,
} from "./learning-linked-withdrawal-fixture.ts";
import type { Env } from "../services/runtime.ts";

async function fixture(
  point: "permission" | "cleanup" | "erasure",
  charged = false,
) {
  const f = linkedFixture(),
    store = f.store(),
    binding = f.binding(1),
    id = binding.offer.lessonId,
    ref = "study:" + id + ":1";
  store.set("studyBinding:" + id, binding);
  await boot(store);
  const result: TerminalResult = {
    sessionId: digest("private-state-session"),
    learner: scope.learner,
    enrollmentId: binding.authorization.id,
    song: {
      chainId: 31337n,
      posts: target.contract,
      communityId,
      postId: digest("post"),
    },
    contentRevision: digest("content"),
    exercisesHash: binding.exercisesHash,
    linesTotal: 4,
    activity: 2,
    grader: target.contract,
    scoringPolicy: digest("score"),
    qualificationPolicy: digest("qualification"),
    startedAt: 900n,
    completedAt: 901n,
    status: 1,
    revision: 1,
    supersedes: zeroHash,
  };
  const outcomes = packStudyOutcomes(
      [1, 2, 3, 4].map((sourceOrdinal) => ({
        sourceOrdinal,
        status: "correct" as const,
      })),
    ),
    data = encodeFunctionData({
      abi: resultsV4Abi,
      functionName: "publish",
      args: [result, outcomes],
    });
  const job: PublicationJob = {
    requestHash: digest("request"),
    telegramFence: binding.offer.telegramFence,
    target,
    result,
    outcomes,
    data,
    receipt: {
      state: point === "erasure" ? "private" : "pending",
      sessionId: result.sessionId,
      chainId: 31337,
      contract: target.contract,
      commitment: resultCommitment(result, outcomes),
      transactionHash: null,
      confirmed: false,
      checkedAt: 1000,
    },
    lastTriedAt: 0,
    privateHistoryExpiresAt: point === "erasure" ? 0 : 9999999999999,
  };
  store.set(
    "studyPublication:" + id,
    JSON.parse(
      JSON.stringify(job, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ),
  );
  const env = {
    RPC_URL: "http://fixture.invalid",
    PAYMENT_CHAIN_ID: "31337",
    RESULTS_V4_CONTRACT: target.contract,
    COMMUNITY_ID: communityId,
    SPONSOR_CAP_WEI: "100000000000000",
    SPONSOR_GAS_PRICE_WEI: "1000",
    SPONSOR_GAS_LIMIT: "100000",
    SPONSOR_DATA_FEE_WEI: "0",
    STUDY_TELEGRAM_AUTHORITY: {
      async fetch(_input: unknown, init?: RequestInit) {
        const { fence, context } = JSON.parse(String(init?.body));
        return Response.json({
          schema: "pirate.study.telegram-fence-observation/1",
          hash: fence.hash,
          contextHash: digest(context),
          allowed: true,
        });
      },
    },
  } as unknown as Env;
  const limits = sponsorLimits(env);
  reserveSponsorship(store, limits, "record_result:" + ref);
  if (point !== "erasure")
    enqueue(store, "record_result", ref, target.contract, data, 21000n);
  if (charged) chargeSponsorship(store, limits, "record_result:" + ref);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const saved = globalThis.fetch;
  let commitments = 0;
  const sends: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const { id: requestId, method, params } = JSON.parse(String(init?.body));
    let value: unknown;
    if (method === "eth_getBlockByNumber")
      value = {
        number: "0x64",
        hash: keccak256("0x6000"),
        timestamp: "0x3e8",
        transactions: [],
      };
    else if (method === "eth_chainId") value = "0x7a69";
    else if (method === "eth_blockNumber") value = "0x64";
    else if (method === "eth_call") {
      const call = decodeFunctionData({
        abi: resultsV4Abi,
        data: params[0].data,
      });
      if (call.functionName === "commitments") {
        commitments++;
        if ((point === "cleanup" && commitments === 2) || point === "erasure") {
          entered.resolve();
          await release.promise;
        }
        value = encodeFunctionResult({
          abi: resultsV4Abi,
          functionName: "commitments",
          result: zeroHash,
        });
      } else if (call.functionName === "authorizationLearner")
        value = encodeFunctionResult({
          abi: resultsV4Abi,
          functionName: "authorizationLearner",
          result: scope.learner,
        });
      else if (call.functionName === "authorizationIssuedAt")
        value = encodeFunctionResult({
          abi: resultsV4Abi,
          functionName: "authorizationIssuedAt",
          result: 100n,
        });
      else if (call.functionName === "authorizedSince") {
        if (point === "permission") {
          entered.resolve();
          await release.promise;
        }
        value = encodeFunctionResult({
          abi: resultsV4Abi,
          functionName: "authorizedSince",
          result: 0n,
        });
      } else throw Error("unscripted contract read " + call.functionName);
    } else if (method === "eth_sendRawTransaction") {
      sends.push(params[0]);
      throw Error("unexpected broadcast");
    } else throw Error("unscripted RPC " + method);
    return Response.json({ jsonrpc: "2.0", id: requestId, result: value });
  }) as typeof fetch;
  const snapshot = () => ({
    intent: intentOf(store, "record_result", ref),
    receipt: store.get<PublicationJob>("studyPublication:" + id)!.receipt,
    sponsorship: store.entries("sponsor:"),
    binding: store.get("studyBinding:" + id),
    closed: store.get("studyPublicationClosed:" + id),
  });
  return {
    ...f,
    store,
    env,
    id,
    entered,
    release,
    sends,
    snapshot,
    stage: () =>
      stageLinkedWithdrawal(store, {
        id: "during-" + point,
        scope,
        kind: "observed",
        identity: { cutoff: 800, nonce: "2" },
      }),
    restore: () => {
      release.resolve();
      globalThis.fetch = saved;
    },
  };
}
for (const point of ["permission", "cleanup", "erasure"] as const)
  for (const charged of point === "erasure" ? [false] : [false, true])
    test(
      `actual resume preserves intent/receipt/sponsorship when withdrawal stages during ${point} (charged=${charged})`,
      { timeout: 10000 },
      async () => {
        const f = await fixture(point, charged);
        try {
          const before = f.snapshot(),
            running = resumeStudyPublication(f.env, f.store, f.id);
          await f.entered.promise;
          f.stage();
          f.release.resolve();
          await assert.rejects(running, LinkedWithdrawalPending);
          assert.deepEqual(f.snapshot(), before);
          assert.deepEqual(f.sends, []);
        } finally {
          f.restore();
          f.close();
        }
      },
    );

for (const charged of [false, true])
  test(
    `settled permanent permission refusal still closes and refunds only unallocated work (charged=${charged})`,
    { timeout: 10000 },
    async () => {
      const f = await fixture("cleanup", charged);
      try {
        const running = resumeStudyPublication(f.env, f.store, f.id);
        await f.entered.promise;
        f.release.resolve();
        const receipt = await running;
        assert.equal(receipt.state, "private");
        assert.equal(receipt.neverSubmitted, true);
        assert.equal(f.snapshot().intent, undefined);
        const ledger = f.store.get<{ spent: string; reserved: string }>(
          "sponsor:ledger",
        )!;
        assert.equal(ledger.spent, "0");
        assert.equal(ledger.reserved, "0");
        assert.deepEqual(f.sends, []);
      } finally {
        f.restore();
        f.close();
      }
    },
  );
