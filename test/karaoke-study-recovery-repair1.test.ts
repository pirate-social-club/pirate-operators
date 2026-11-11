import { currentOperatorAuthorityFixture } from "./learning-current-authority-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV3Abi,
  resultCommitment,
} from "../packages/protocol/learning-results-v3.ts";
import { registerHooks } from "node:module";
import type { Store, Env } from "../services/runtime.ts";
import type { PublicationJob } from "../services/study-publication.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";
import { guardLinkedWithdrawal } from "../services/study-linked-withdrawal.ts";

// records.ts imports the runtime's pure service-call reexports. Load those same
// functions without constructing the Cloudflare-only runtime in Node. The tick,
// publication recovery and store transactions below are the production code.
const runtimeUrl = new URL("../services/runtime.ts", import.meta.url).href;
const serviceCallUrl = new URL("../services/service-call.ts", import.meta.url)
  .href;
const hook = registerHooks({
  load(url, context, next) {
    return url === runtimeUrl
      ? {
          format: "module",
          shortCircuit: true,
          source: `export {body, call, signatureChainId} from ${JSON.stringify(serviceCallUrl)};`,
        }
      : next(url, context);
  },
});
const { tick } = await import("../services/karaoke.ts");
hook.deregister();

test("current authority fixture keeps legacy stores and an unconfigured source denied", async () => {
  const legacy = speechRepairFixture();
  const authority = currentOperatorAuthorityFixture({
    now: legacy.store.now,
    rpcUrl: "http://fixture.invalid",
  });
  const scope = {
    communityId: digest("missing-source-community"),
    learner: `0x${"11".repeat(20)}` as const,
    target: {
      version: 4 as const,
      chainId: 31337 as const,
      contract: `0x${"22".repeat(20)}` as const,
    },
  };
  try {
    // Actual indexed SQLite and a durable bootstrap do not select a source.
    // The legacy journal stays unsupported; a Store without a source stays pending.
    await authority.initialize();
    assert.ok(authority.alarm() !== null);
    assert.throws(
      () => guardLinkedWithdrawal(legacy.store, scope),
      /study_linked_withdrawal_pending/,
    );
    assert.throws(
      () => guardLinkedWithdrawal(authority.store, scope),
      /study_linked_withdrawal_pending/,
    );
    assert.equal(authority.sources.length, 0);
    assert.equal(
      authority.store.entries("linkedWithdrawalOperation:").length,
      0,
    );
  } finally {
    authority.close();
    legacy.close();
  }
});

test("alarm tick resumes pending Study work with V4-only and retains historical profile admission", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("fixture RPC unavailable; recovery must retain work");
  });
  for (const version of [undefined, 2, 3, 4] as const) {
    const admission = speechRepairFixture();
    const authority =
      version === 4
        ? currentOperatorAuthorityFixture({
            now: admission.store.now,
            rpcUrl: "http://fixture.invalid",
          })
        : undefined;
    if (authority) await authority.initialize();
    const f = {
      ...admission,
      store: authority?.store ?? admission.store,
      close() {
        authority?.close();
        admission.close();
      },
    };
    try {
      const { result, outcomes } = studyResultFixture().bundle;
      const contract = `0x${"2".repeat(40)}` as const;
      const job: PublicationJob = {
        requestHash: digest("recovery"),
        target: { chainId: 31337, version: version === 4 ? 4 : 3, contract },
        result,
        outcomes,
        data: encodeFunctionData({
          abi: resultsV3Abi,
          functionName: "publish",
          args: [result, outcomes],
        }),
        lastTriedAt: f.store.now() - 100,
        privateHistoryExpiresAt: (f.store.now() + 3600) * 1000,
        receipt: {
          state: "pending",
          sessionId: result.sessionId,
          chainId: 31337,
          contract,
          commitment: resultCommitment(result, outcomes),
          transactionHash: null,
          confirmed: false,
          checkedAt: f.store.now() - 100,
        },
      };
      const key = "studyPublication:alarm-repair1-fixture";
      f.store.set(
        key,
        JSON.parse(
          JSON.stringify(job, (_key, value) =>
            typeof value === "bigint" ? String(value) : value,
          ),
        ),
      );
      const env = {
        PAYMENT_CHAIN_ID: "31337",
        ...(version ? { [`RESULTS_V${version}_CONTRACT`]: contract } : {}),
      } as Env;
      await tick(env, f.store as unknown as Store);
      assert.equal(
        f.store.get<PublicationJob>(key)?.lastTriedAt,
        version === 3 || version === 4 ? f.store.now() : f.store.now() - 100,
        `profile V${version}`,
      );
      assert.equal(f.store.get<PublicationJob>(key)?.receipt.state, "pending");
      assert.equal(f.store.entries("tx:").length, 0);
    } finally {
      f.close();
    }
  }
});
