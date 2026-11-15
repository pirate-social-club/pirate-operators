// Current808 fixture correction. UNRUN. Actual local V4 contract, signed revoke,
// Store/index/source/bootstrap and canonical receipt recovery. The only hook
// delays a real pinned eth_call while the original transaction confirms.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
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
import {
  revocationKey,
  resultsTarget,
  legacyResultsWithheldKey,
} from "../services/learning-contract.ts";
import {
  guardLinkedWithdrawal,
  stageLinkedWithdrawal,
} from "../services/study-linked-withdrawal.ts";
import {
  intentOf,
  txRow,
  provenUnsent,
  refresh as refreshTransaction,
} from "../services/operator-tx.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  scopeOf,
  headKey,
  opKey,
  workKey,
  watchKey,
  bootstrapKey,
  type WithdrawalOperation,
  type WithdrawalHead,
} from "../services/study-linked-withdrawal-contract.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
import type { Env } from "../services/runtime.ts";

test(
  "a revocation confirming during pinned reads cannot make its older snapshot ready for turn-on",
  { timeout: 120000 },
  async (t) => {
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
      // Only record_result owns the broadcast marker. An absent marker on
      // this signed revoke is unknown delivery, never proof of being unsent.
      assert.equal(original.kind, "record_revoke");
      assert.equal(original.broadcast, undefined);
      assert.equal(provenUnsent(original), false);
      assert.equal(original.cancellation, undefined);
      assert.ok(original.raw && original.hash);
      assert.equal(original.to.toLowerCase(), target.contract.toLowerCase());
      const originalRaw = original.raw,
        originalHash = original.hash;
      const pinned = await evm.publicClient.getBlockNumber({ cacheTime: 0 });
      const blockTag = "0x" + pinned.toString(16);
      const ownedRpc = new URL(evm.rpcUrl).href;
      const originalSends: Hex[] = [];
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
        const receipt = await evm.publicClient.getTransactionReceipt({
          hash: originalHash,
        });
        assert.equal(receipt.status, "success");
        const withdrawalBlock = await evm.publicClient.getBlock({
          blockNumber: receipt.blockNumber,
        });
        assert.equal(withdrawalBlock.hash, receipt.blockHash);
        const safeBefore = await evm.publicClient.getBlock({
          blockTag: "safe",
        });
        // Keep Anvil's default 32-slot policy and the original signed receipt.
        // Mature real descendants before asking the actual proof port to recover.
        await evm.rpc("anvil_mine", ["0x20"]);
        now = Number((await evm.publicClient.getBlock()).timestamp);
        await evm.rpc("evm_setNextBlockTimestamp", [now + 6]);
        await evm.rpc("evm_mine", []);
        now = Number((await evm.publicClient.getBlock()).timestamp);
        const safeAfter = await evm.publicClient.getBlock({ blockTag: "safe" });
        assert.ok(safeAfter.number >= receipt.blockNumber);
        assert.ok(safeAfter.timestamp >= withdrawalBlock.timestamp);
        assert.ok(safeAfter.number >= safeBefore.number);
        const dueWork = store.entries("linkedWithdrawalWork:");
        assert.ok(dueWork.length > 0);
        assert.ok(
          dueWork.every(({ value }) => (value as { due: number }).due <= now),
        );
        const markerKey = legacyResultsWithheldKey(learner);
        const marker = store.get<{ at: number; nonce: string }>(markerKey);
        assert.ok(marker);
        assert.equal(marker.nonce, String(nonce));
        await authority!.recover();
        const canonicalScope = scopeOf(scope);
        const acknowledgementKey =
          "linkedWithdrawalLegacy:" + digest(canonicalScope);
        assert.deepEqual(store.entries("linkedWithdrawalWork:"), []);
        assert.equal(store.get(acknowledgementKey), undefined);
        assert.throws(
          () => guardLinkedWithdrawal(store, scope),
          /study_linked_withdrawal_pending/,
        );
        // Proof merges persist a future watch. Honor that exact scope/deadline;
        // the work scan precedes watch discovery, so processing is a later phase.
        const watch = store.get<{
          scope: ReturnType<typeof scopeOf>;
          due: number;
        }>(watchKey(scope));
        assert.ok(watch);
        assert.deepEqual(watch.scope, canonicalScope);
        assert.ok(
          Number.isSafeInteger(watch.due) &&
            watch.due > now &&
            watch.due <= now + 60,
        );
        assert.deepEqual(store.get(markerKey), marker);
        await evm.rpc("evm_setNextBlockTimestamp", [watch.due]);
        await evm.rpc("evm_mine", []);
        now = Number((await evm.publicClient.getBlock()).timestamp);
        assert.equal(now, watch.due);
        await authority!.recover();
        const legacyId = digest(["legacy", canonicalScope, marker]);
        const legacyWork = store.entries("linkedWithdrawalWork:");
        assert.equal(legacyWork.length, 1);
        assert.equal(legacyWork[0]!.key, workKey(legacyId));
        const work = legacyWork[0]!.value as {
          operationId: string;
          due: number;
        };
        assert.equal(work.operationId, legacyId);
        assert.equal(work.due, now);
        assert.ok(work.due <= now);
        const legacy = store.get<WithdrawalOperation>(opKey(legacyId));
        assert.ok(legacy);
        assert.equal(legacy.id, legacyId);
        assert.equal(legacy.kind, "legacy");
        assert.deepEqual(legacy.scope, canonicalScope);
        assert.deepEqual(legacy.identity, marker);
        assert.equal(legacy.proof, undefined);
        assert.equal(store.get(acknowledgementKey), undefined);
        assert.deepEqual(store.get(markerKey), marker);
        await authority!.recover();
        const recoveredLegacy = store.get<WithdrawalOperation>(opKey(legacyId));
        assert.equal(recoveredLegacy?.proof?.kind, "success");
        assert.equal(
          recoveredLegacy?.proof?.original?.transactionHash,
          originalHash,
        );
        assert.deepEqual(store.get(markerKey), marker);
        assert.equal(store.get(acknowledgementKey), digest(marker));
        guardLinkedWithdrawal(store, scope);
      };
      let fired = false,
        busy = false;
      const pinnedReads: string[] = [];
      const pinnedTrace: { tag: string; selector: string; busy: boolean }[] =
        [];
      let hookFailed = false;
      let hookFailure: unknown;
      const hookFailures: {
        phase: string;
        message: string;
        elapsedMs: number;
        aborted: boolean;
      }[] = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const started = performance.now();
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
        const actualRpc =
          new URL(input instanceof Request ? input.url : String(input)).href ===
          ownedRpc;
        if (
          actualRpc &&
          rpc?.method === "eth_sendRawTransaction" &&
          rpc.params?.[0] === originalRaw
        )
          originalSends.push(originalRaw);
        if (
          actualRpc &&
          rpc?.method === "eth_call" &&
          call?.to?.toLowerCase() === contract.toLowerCase() &&
          selectors.includes(call.data as Hex) &&
          rpc.params?.[1] === blockTag
        ) {
          pinnedReads.push(String(rpc.params[1]));
          pinnedTrace.push({
            tag: String(rpc.params[1]),
            selector: String(call.data).slice(0, 10),
            busy,
          });
          if (!fired && !busy) {
            fired = true;
            busy = true;
            try {
              // The controlled local crash did not send the already accepted
              // raw transaction. Deliver that exact original once while this
              // old read is held; the journal marker still remains unknown.
              assert.equal(
                await evm.rpc("eth_sendRawTransaction", [originalRaw]),
                originalHash,
              );
              // RPC acceptance does not guarantee mining. Await this exact
              // original receipt before exercising receipt-only recovery.
              const receipt = await evm.publicClient.waitForTransactionReceipt({
                hash: originalHash,
                confirmations: 1,
                checkReplacement: false,
                pollingInterval: 25,
                timeout: 5_000,
              });
              assert.equal(receipt.status, "success");
              const safeBefore = await evm.publicClient.getBlock({
                blockTag: "safe",
              });
              assert.ok(safeBefore.number < receipt.blockNumber);
              // Actual production receipt-only recovery runs BEFORE accepting
              // the retained job again. It cannot rebroadcast or cancel.
              const refreshed = await refreshTransaction(
                env,
                store,
                intent.nonce!,
              );
              assert.equal(refreshed?.mined?.status, "success");
              const mined = await acceptRevocationV4(
                env,
                store,
                learner,
                nonce,
                revokeSignature,
              );
              assert.equal(mined?.mined?.status, "success");
              assert.deepEqual(originalSends, [originalRaw]);
              now = Number((await evm.publicClient.getBlock()).timestamp);
              assert.equal(
                store.get<{ pending: boolean }>(key)?.pending,
                false,
              );
            } catch (error) {
              // Viem retries a rejected fetch hook. Preserve the original
              // assertion rather than letting a retry obscure its cause.
              if (!hookFailed) hookFailure = error;
              hookFailed = true;
              hookFailures.push({
                phase: "mutation",
                message: error instanceof Error ? error.message : String(error),
                elapsedMs: performance.now() - started,
                aborted: init?.signal?.aborted ?? false,
              });
              throw error;
            } finally {
              busy = false;
            }
          }
        }
        try {
          return await real(input, init);
        } catch (error) {
          if (actualRpc) {
            if (!hookFailed) hookFailure = error;
            hookFailed = true;
            hookFailures.push({
              phase: "forward",
              message: error instanceof Error ? error.message : String(error),
              elapsedMs: performance.now() - started,
              aborted: init?.signal?.aborted ?? false,
            });
          }
          throw error;
        }
      }) as typeof fetch;
      // Same old-snapshot assertion, using the real sign-in's immutable time.
      let observedState: Awaited<ReturnType<typeof authorizationState>>;
      try {
        observedState = await authorizationState(env, learner, store);
      } catch (error) {
        if (hookFailed) throw hookFailure;
        throw error;
      } finally {
        t.diagnostic(
          JSON.stringify({ blockTag, pinnedTrace, hookFailed, hookFailures }),
        );
      }
      if (hookFailed) throw hookFailure;
      assert.deepEqual(observedState, {
        since: Number(signIn.issuedAt),
        revokedAt: 0,
        revocationNonce: "0",
        pendingWithdrawal: true,
        linkedWithdrawalPending: true,
      });
      assert.equal(fired, true);
      assert.equal(pinnedReads.length, 3);
      assert.ok(pinnedReads.every((tag) => tag === blockTag));
      const revokedAt = Number(
        await evm.read(contract, "LearningResultsV4", "revokedAt", [learner]),
      );
      assert.ok(revokedAt > 0);
      // Reproduce one retained pre-fix checksum ID through the actual staging
      // API using the original on-chain cutoff/nonce. It must survive; no proof,
      // bootstrap/head/ready row is seeded or erased by this fixture.
      const oldScope = {
        communityId,
        target: resultsTarget(env, 4),
        learner: getAddress(learner),
      };
      const canonicalScope = scopeOf(oldScope);
      const retainedId = digest(["observed", oldScope, String(revokedAt), "1"]);
      const canonicalId = digest([
        "observed",
        canonicalScope,
        String(revokedAt),
        "1",
      ]);
      assert.notEqual(retainedId, canonicalId);
      await store.durableStudyWrite(() =>
        stageLinkedWithdrawal(store, {
          id: retainedId,
          scope: oldScope,
          kind: "observed",
          identity: { cutoff: String(revokedAt), nonce: "1" },
        }),
      );
      const retainedObservation = store.get<WithdrawalOperation>(
        opKey(retainedId),
      )!;
      assert.equal(retainedObservation.proof, undefined);
      assert.deepEqual(retainedObservation.scope, canonicalScope);
      // A current canonical observation also stays held until genuine proof
      // recovers all retained work. Keep the later-ready assertion intact.
      const observed = await authorizationState(
        env,
        learner.toLowerCase() as Address,
        store,
      );
      assert.equal(observed.linkedWithdrawalPending, true);
      assert.equal(observed.revokedAt, revokedAt);
      await recoverReady();
      assert.deepEqual(await authorizationState(env, learner, store), {
        since: 0,
        revokedAt,
        revocationNonce: "1",
      });
      const recoveredOld = store.get<WithdrawalOperation>(opKey(retainedId))!;
      assert.equal(recoveredOld.id, retainedId);
      assert.deepEqual(recoveredOld.identity, retainedObservation.identity);
      assert.deepEqual(recoveredOld.scope, retainedObservation.scope);
      assert.equal(recoveredOld.proof?.kind, "observed");
      assert.equal(recoveredOld.proof?.revokedAtS, revokedAt);
      assert.equal(recoveredOld.proof?.nextNonce, "1");
      assert.ok(store.get<WithdrawalOperation>(opKey(canonicalId))?.proof);
      const head = store.get<WithdrawalHead>(headKey(canonicalScope))!;
      assert.equal(head.openProofs, 0);
      assert.equal(head.sealed, true);
      assert.equal(head.cutoffS, revokedAt);
      assert.equal(head.nextNonce, "1");
      const retainedOperations = store.entries("linkedWithdrawalOperation:");
      const retainedHeads = store.entries("linkedWithdrawalHead:");
      const retainedBootstrap = store.get(bootstrapKey);
      const sponsorship = store.entries("sponsor:");
      for (const spelling of [
        learner.toLowerCase() as Address,
        getAddress(learner),
      ]) {
        assert.deepEqual(await authorizationState(env, spelling, store), {
          since: 0,
          revokedAt,
          revocationNonce: "1",
        });
        assert.deepEqual(
          store.entries("linkedWithdrawalOperation:"),
          retainedOperations,
        );
        assert.deepEqual(store.entries("linkedWithdrawalHead:"), retainedHeads);
        assert.deepEqual(store.get(bootstrapKey), retainedBootstrap);
        assert.deepEqual(store.entries("sponsor:"), sponsorship);
      }
      assert.equal(
        store.get<{ pending: boolean }>(
          revocationKey(target, accounts[6].address, 0n),
        )?.pending,
        true,
      );
      assert.equal(
        store.get<{ pending: boolean }>(
          revocationKey(
            { ...target, contract: accounts[0].address },
            learner,
            0n,
          ),
        )?.pending,
        true,
      );
      assert.equal(
        store.get(headKey({ ...canonicalScope, learner: accounts[6].address })),
        undefined,
      );
      assert.throws(
        () =>
          guardLinkedWithdrawal(store, {
            ...canonicalScope,
            target: { ...target, contract: accounts[0].address },
          }),
        /study_linked_withdrawal_pending/,
      );
      assert.deepEqual(originalSends, [originalRaw]);
      const retained = txRow(store, intent.nonce!)!;
      assert.equal(retained.raw, originalRaw);
      assert.equal(retained.hash, originalHash);
      assert.equal(retained.nonce, original.nonce);
      assert.equal(retained.to, original.to);
      assert.equal(retained.data, original.data);
      assert.equal(retained.broadcast, undefined);
      assert.equal(provenUnsent(retained), false);
      assert.equal(retained.cancellation, undefined);
      assert.equal(store.entries("intent:record_revoke:").length, 1);
    } finally {
      globalThis.fetch = real;
      authority?.close();
      await stopChain(evm);
    }
  },
);
