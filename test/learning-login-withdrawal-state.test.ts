// Current808 fixture correction. UNRUN. Actual local V4 contract, signed revoke,
// Store/index/source/bootstrap and canonical receipt recovery. The only hook
// delays a real pinned eth_call while the original transaction confirms.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { stopChain } from "./payments-fixture.ts";
import { currentOperatorAuthorityFixture } from "./learning-current-authority-fixture.ts";
import {
  acceptRevocationV4,
  authorizationState,
  revocationRequestV4,
  revocationIdV4,
} from "../services/learning-authorization.ts";
import {
  resultsV4Abi,
  signInMessageV4,
} from "../packages/protocol/learning-results-v4.ts";
import { revocationKey } from "../services/learning-contract.ts";
import { guardLinkedWithdrawal } from "../services/study-linked-withdrawal.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import { digest } from "../packages/protocol/index.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
import type { Env } from "../services/runtime.ts";

test(
  "a revocation confirming during pinned reads cannot make its older snapshot ready for turn-on",
  { timeout: 120000 },
  async () => {
    const evm = await chain(20366);
    const real = globalThis.fetch;
    let authority:
      | ReturnType<typeof currentOperatorAuthorityFixture>
      | undefined;
    try {
      const communityId = digest("pinned-withdrawal-community");
      const learner = accounts[5].address;
      const contract = await evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        firstSong.origin,
      ]);
      let now = Number((await evm.publicClient.getBlock()).timestamp);
      const signIn = {
        learner,
        nonce: digest("pinned-original-sign-in"),
        issuedAt: BigInt(now),
      };
      const signature = await accounts[5].signMessage({
        message: signInMessageV4(
          {
            origin: firstSong.origin,
            chainId: 31337,
            contract: contract.toLowerCase() as Address,
            communityId,
            publicationPolicy: learningV4PublicityPolicy,
          },
          signIn,
        ),
      });
      await evm.write(
        contract,
        "LearningResultsV4",
        "authorize",
        [signIn, signature],
        2,
      );
      now = Number((await evm.publicClient.getBlock()).timestamp);
      authority = currentOperatorAuthorityFixture({
        now: () => now,
        rpcUrl: evm.rpcUrl,
      });
      await assert.rejects(
        authority.selectV4(digest("wrong-source-community"), contract),
        { code: "ERR_ASSERTION" },
      );
      assert.equal(
        authority.sources.length,
        0,
        "a mismatched real runtime is not admitted",
      );
      await authority.selectV4(communityId, contract);
      const notBootstrapped = currentOperatorAuthorityFixture({
        now: () => now,
        rpcUrl: evm.rpcUrl,
        sources: authority.sources,
      });
      try {
        assert.throws(
          () =>
            guardLinkedWithdrawal(notBootstrapped.store, {
              communityId,
              learner,
              target: { chainId: 31337, version: 4, contract },
            }),
          /study_linked_withdrawal_pending/,
        );
      } finally {
        notBootstrapped.close();
      }
      const store = authority.store,
        entries = store.entries.bind(store);
      store.entries = (prefix) => {
        assert.ok(
          prefix.length < 50,
          "Durable Object SQLite limits LIKE patterns",
        );
        return entries(prefix);
      };
      const env = {
        RPC_URL: evm.rpcUrl,
        PAYMENT_CHAIN_ID: "31337",
        RESULTS_V4_CONTRACT: contract,
        COMMUNITY_ID: communityId,
        OPERATOR_ADDRESS: accounts[2].address,
        PRIVATE_KEY: keys[2],
        SERVICE_MODE: "internal",
        SPONSOR_CAP_WEI: "1000000000000000000",
        SPONSOR_GAS_PRICE_WEI: "10000000000",
        SPONSOR_GAS_LIMIT: "2000000",
        SPONSOR_DATA_FEE_WEI: "0",
      } as Env;
      const target = { chainId: 31337, version: 4, contract } as const;
      const typed = await revocationRequestV4(env, learner);
      const revokeSignature = await accounts[5].signTypedData(typed as never);
      const nonce = BigInt(typed.message.nonce);
      assert.equal(nonce, 0n);
      const grantId = revocationIdV4(target, learner, nonce);
      const key = revocationKey(target, learner, nonce);
      // Preserve unrelated-account/target pending rows: neither may govern this
      // learner's pinned read. They remain negative selection witnesses.
      store.set(revocationKey(target, accounts[6].address, 0n), {
        pending: true,
      });
      store.set(
        revocationKey(
          { ...target, contract: accounts[0].address },
          learner,
          0n,
        ),
        { pending: true },
      );
      store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptRevocationV4(env, store, learner, nonce, revokeSignature),
        /simulated_crash_before_broadcast/,
      );
      const intent = intentOf(store, "record_revoke", grantId)!;
      const original = txRow(store, intent.nonce!)!;
      assert.equal(original.broadcast, "none");
      assert.ok(original.raw && original.hash);
      const originalRaw = original.raw,
        originalHash = original.hash;
      const pinned = await evm.publicClient.getBlockNumber({ cacheTime: 0 });
      const blockTag = "0x" + pinned.toString(16);
      const selectors = ["authorizedSince", "revokedAt", "nextNonce"].map(
        (functionName) =>
          encodeFunctionData({
            abi: resultsV4Abi,
            functionName: functionName as
              | "authorizedSince"
              | "revokedAt"
              | "nextNonce",
            args: [learner],
          }),
      );
      const scope = { communityId, target, learner };
      const recoverReady = async () => {
        for (let pass = 0; pass < 4; pass++) {
          await authority!.recover();
          try {
            guardLinkedWithdrawal(store, scope);
            return;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "study_linked_withdrawal_pending"
            )
              throw error;
          }
          // Genuine blocks/time only. Unsupported canonical proof reads remain
          // a failing gate; no favourable RPC fallback or synthetic proof exists.
          await evm.rpc("evm_setNextBlockTimestamp", [now + 6]);
          await evm.rpc("evm_mine", []);
          now = Number((await evm.publicClient.getBlock()).timestamp);
        }
        guardLinkedWithdrawal(store, scope);
      };
      let fired = false,
        busy = false;
      const pinnedReads: string[] = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const text = typeof init?.body === "string" ? init.body : "";
        let rpc: { method?: string; params?: unknown[] } | undefined;
        try {
          rpc = JSON.parse(text);
        } catch {
          /* Non-RPC is passed unchanged. */
        }
        const call = rpc?.params?.[0] as
          | { to?: string; data?: string }
          | undefined;
        if (
          (input instanceof Request ? input.url : String(input)) ===
            evm.rpcUrl &&
          rpc?.method === "eth_call" &&
          call?.to?.toLowerCase() === contract.toLowerCase() &&
          selectors.includes(call.data as Hex) &&
          rpc.params?.[1] === blockTag
        ) {
          pinnedReads.push(String(rpc.params[1]));
          if (!fired && !busy) {
            fired = true;
            busy = true;
            try {
              let mined = await acceptRevocationV4(
                env,
                store,
                learner,
                nonce,
                revokeSignature,
              );
              for (let retry = 0; !mined?.mined && retry < 4; retry++)
                mined = await acceptRevocationV4(
                  env,
                  store,
                  learner,
                  nonce,
                  revokeSignature,
                );
              assert.equal(mined?.mined?.status, "success");
              now = Number((await evm.publicClient.getBlock()).timestamp);
              assert.equal(
                store.get<{ pending: boolean }>(key)?.pending,
                false,
              );
              await recoverReady();
            } finally {
              busy = false;
            }
          }
        }
        return real(input, init);
      }) as typeof fetch;
      // Same old-snapshot assertion, using the real sign-in's immutable time.
      assert.deepEqual(await authorizationState(env, learner, store), {
        since: Number(signIn.issuedAt),
        revokedAt: 0,
        revocationNonce: "0",
        pendingWithdrawal: true,
      });
      assert.equal(fired, true);
      assert.equal(pinnedReads.length, 3);
      assert.ok(pinnedReads.every((tag) => tag === blockTag));
      const revokedAt = Number(
        await evm.read(contract, "LearningResultsV4", "revokedAt", [learner]),
      );
      assert.ok(revokedAt > 0);
      // A current observation stages its own canonical proof hold; only real
      // recovery may clear it. Keep the original later-ready assertion intact.
      const observed = await authorizationState(env, learner, store);
      assert.equal(observed.linkedWithdrawalPending, true);
      assert.equal(observed.revokedAt, revokedAt);
      await recoverReady();
      assert.deepEqual(await authorizationState(env, learner, store), {
        since: 0,
        revokedAt,
        revocationNonce: "1",
      });
      const retained = txRow(store, intent.nonce!)!;
      assert.equal(retained.raw, originalRaw);
      assert.equal(retained.hash, originalHash);
      assert.equal(retained.nonce, original.nonce);
      assert.equal(store.entries("intent:record_revoke:").length, 1);
    } finally {
      globalThis.fetch = real;
      authority?.close();
      await stopChain(evm);
    }
  },
);
