// The coordinator owns/qualifies the imported proof. This composition pins
// original stored targets and signed bytes; it has no current-default fallback.
import {
  createPublicClient,
  http,
  recoverTransactionAddress,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import { observeStudyWithdrawal } from "./study-withdrawal-proof.ts";
import { revocationKey, sameResultsTarget } from "./learning-contract.ts";
import { intentOf, txRow } from "./operator-tx.ts";
import {
  checkSource,
  type LinkedScope,
  type LinkedStore,
  type WithdrawalPorts,
  type WithdrawalSource,
} from "./study-linked-withdrawal-contract.ts";

export function withdrawalSourceFor(
  sources: readonly WithdrawalSource[],
  scope: LinkedScope,
) {
  const selected = sources.filter(
    (s) =>
      s.communityId === scope.communityId &&
      sameResultsTarget(s.target, scope.target),
  );
  check(selected.length === 1, "study_withdrawal_source_unconfigured");
  checkSource(scope, selected[0]);
  return selected[0];
}
export function withdrawalPorts(options: {
  store: LinkedStore;
  sources: readonly WithdrawalSource[];
  /** MUST abort underlying read transports, including retries, with signal. */
  client(source: WithdrawalSource, signal: AbortSignal): PublicClient;
}): WithdrawalPorts {
  return {
    source: (scope) => withdrawalSourceFor(options.sources, scope),
    async original(op) {
      if (op.kind === "observed") return null;
      const identity = op.identity as { nonce?: string };
      if (
        typeof identity?.nonce !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(identity.nonce)
      )
        return null;
      const job = options.store.get<{
        target: LinkedScope["target"];
        learner: string;
        nonce: string;
        signature: string;
        data: `0x${string}`;
        grantId: `0x${string}`;
      }>(
        revocationKey(
          op.scope.target,
          op.scope.learner,
          BigInt(identity.nonce),
        ),
      );
      if (!job) return null;
      check(
        job.nonce === identity.nonce &&
          job.learner.toLowerCase() === op.scope.learner &&
          sameResultsTarget(job.target, op.scope.target),
        "study_withdrawal_original_changed",
      );
      if (op.kind === "signed")
        check(
          digest({
            target: job.target,
            learner: job.learner,
            nonce: job.nonce,
            signature: job.signature,
            data: job.data,
            grantId: job.grantId,
          }) === digest(op.identity),
          "study_withdrawal_original_changed",
        );
      const intent = intentOf(options.store, "record_revoke", job.grantId),
        row =
          intent?.nonce == null
            ? undefined
            : txRow(options.store, intent.nonce);
      if (!row?.raw || !row.hash) return null;
      check(
        row.kind === "record_revoke" &&
          row.ref === job.grantId &&
          row.to.toLowerCase() === op.scope.target.contract.toLowerCase() &&
          row.data === job.data &&
          row.chainId === op.scope.target.chainId,
        "study_withdrawal_original_changed",
      );
      const raw = row.raw,
        hash = row.hash,
        nonce = row.nonce,
        sender = await recoverTransactionAddress({
          serializedTransaction: raw as TransactionSerialized,
        });
      const current = txRow(options.store, nonce);
      check(
        current?.raw === raw &&
          current.hash === hash &&
          current.data === job.data,
        "study_withdrawal_original_changed",
      );
      return {
        nonce: job.nonce,
        data: job.data,
        transaction: { raw, hash, nonce, sender },
      };
    },
    observe: ({ source, learner, original }, signal) =>
      observeStudyWithdrawal({
        client: options.client(source, signal),
        source,
        learner,
        ...(original ? { original } : {}),
      }),
  };
}

export function parseWithdrawalSources(
  value: string | undefined,
): readonly WithdrawalSource[] {
  if (value === undefined) return []; // No linked source is admitted by omission.
  const sources: unknown = JSON.parse(value);
  check(Array.isArray(sources), "study_withdrawal_source_unconfigured");
  const result = sources as WithdrawalSource[];
  for (const source of result)
    checkSource(
      {
        communityId: source.communityId,
        target: source.target,
        learner: "0x0000000000000000000000000000000000000001",
      },
      source,
    );
  return result;
}
export function configuredWithdrawalPorts(
  env: { RPC_URL?: string; STUDY_WITHDRAWAL_SOURCES_JSON?: string },
  store: LinkedStore,
) {
  return withdrawalPorts({
    store,
    sources: parseWithdrawalSources(env.STUDY_WITHDRAWAL_SOURCES_JSON),
    client: (_source, signal) => {
      check(env.RPC_URL, "study_withdrawal_rpc_unconfigured");
      return createPublicClient({
        transport: http(env.RPC_URL, {
          retryCount: 0,
          timeout: 2000,
          fetchOptions: { signal },
        }),
      });
    },
  });
}
