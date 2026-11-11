// Structural dependencies only. The coordinator owns the index and canonical
// proof implementations; their prepared drafts are not admission authority.
import type { Address, Hex } from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import type { ResultsTarget } from "./learning-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";

export interface LinkedScope {
  communityId: string;
  learner: Address;
  target: ResultsTarget;
}
export interface WithdrawalSource {
  target: ResultsTarget;
  communityId: Hex;
  runtimeCodeHash: Hex;
}
export interface OriginalWithdrawal {
  nonce: string;
  data: Hex;
  transaction: { raw: Hex; hash: Hex; nonce: number; sender: Address };
}
export interface WithdrawalProof {
  schema: "pirate.study.linked-withdrawal-proof/1";
  kind: "observed" | "success" | "reverted" | "authority_covered";
  source: WithdrawalSource;
  learner: Address;
  revokedAtS: number;
  issuanceFloorS: number;
  nextNonce: string;
  anchor: { number: string; hash: Hex; timestampS: number };
  original?: {
    nonce: string;
    transactionHash: Hex;
    receipt?: {
      blockNumber: string;
      blockHash: Hex;
      status: "success" | "reverted";
    };
  };
  proofHash: Hex;
}
export interface LinkedStore extends ResultStore {
  linkedWithdrawalSource(scope: LinkedScope): WithdrawalSource;
  hasUnclassifiedLegacyWithdrawal(): boolean;
  page(
    prefix: string,
    after: string,
    limit: number,
  ): { key: string; value: unknown }[];
  linkedStudyBindings: {
    hasUnclassified(): boolean;
    page(
      input: LinkedScope & { after: string; limit: number },
    ): { key: string; value: unknown }[];
  };
  durableStudyWrite<T>(work: () => T): Promise<T>;
}
export interface WithdrawalPorts {
  /** Select the actual admitted runtime for this original target, not defaults. */
  source(scope: LinkedScope): WithdrawalSource;
  original(
    operation: WithdrawalOperation,
  ): OriginalWithdrawal | null | Promise<OriginalWithdrawal | null>;
  /** Read-only, cancellation-aware transport around the prepared proof module. */
  observe(
    input: {
      source: WithdrawalSource;
      learner: Address;
      original?: OriginalWithdrawal;
    },
    signal: AbortSignal,
  ): Promise<WithdrawalProof | null>;
}
export interface WithdrawalHead {
  scope: LinkedScope;
  revision: number;
  openProofs: number;
  cutoffS: number;
  recoveryFloorS: number;
  nextNonce: string;
  cursor: string;
  sealed: boolean;
  error?: string;
  legacyFingerprint?: string;
}
export interface WithdrawalOperation {
  id: string;
  identity: unknown;
  scope: LinkedScope;
  kind: "signed" | "observed" | "legacy";
  original?: OriginalWithdrawal;
  source?: WithdrawalSource;
  proof?: WithdrawalProof;
}
export interface WithdrawalBootstrap {
  version: 2;
  revision: number;
  phase: "markers" | "bindings" | "ready";
  cursor: string;
  error?: string;
}
export const bootstrapKey = "linkedWithdrawalBootstrap:2";
export const headKey = (scope: LinkedScope) =>
  "linkedWithdrawalHead:" + digest(scopeOf(scope));
export const opKey = (id: string) => "linkedWithdrawalOperation:" + id;
export const workKey = (id: string) => "linkedWithdrawalWork:" + id;
export const watchKey = (scope: LinkedScope) =>
  "linkedWithdrawalWatch:" + digest(scopeOf(scope));
export const scopeOf = (scope: LinkedScope): LinkedScope => ({
  communityId: scope.communityId.toLowerCase(),
  learner: scope.learner.toLowerCase() as Address,
  target: {
    ...scope.target,
    contract: scope.target.contract.toLowerCase() as Address,
  },
});
export const newHead = (scope: LinkedScope): WithdrawalHead => ({
  scope: scopeOf(scope),
  revision: 0,
  openProofs: 0,
  cutoffS: 0,
  recoveryFloorS: 0,
  nextNonce: "0",
  cursor: "studyBinding:",
  sealed: true,
});
export class LinkedWithdrawalPending extends Error {
  readonly status = 503;
  readonly retryable = true;
  constructor() {
    super("study_linked_withdrawal_pending");
  }
}
export function pending(condition: unknown): asserts condition {
  if (!condition) throw new LinkedWithdrawalPending();
}
export function linkedStore(store: ResultStore): LinkedStore {
  const candidate = store as LinkedStore;
  pending(
    candidate.page &&
      candidate.durableStudyWrite &&
      candidate.linkedWithdrawalSource &&
      candidate.hasUnclassifiedLegacyWithdrawal &&
      candidate.linkedStudyBindings?.page &&
      candidate.linkedStudyBindings.hasUnclassified,
  );
  return candidate;
}
export function checkSource(scope: LinkedScope, source: WithdrawalSource) {
  check(
    scope.target.version === 4 &&
      [31337, 6343].includes(scope.target.chainId) &&
      /^0x[0-9a-f]{64}$/i.test(scope.communityId) &&
      /^0x[0-9a-f]{40}$/i.test(scope.learner) &&
      /^0x[0-9a-f]{40}$/i.test(scope.target.contract) &&
      digest(
        scopeOf({
          ...scope,
          communityId: source.communityId,
          target: source.target,
        }),
      ) === digest(scopeOf(scope)) &&
      /^0x[0-9a-f]{64}$/i.test(source.runtimeCodeHash) &&
      BigInt(source.runtimeCodeHash) > 0n,
    "study_withdrawal_source_changed",
  );
}
export function bootstrap(store: ResultStore) {
  return store.get<WithdrawalBootstrap>(bootstrapKey);
}
export function bumpBootstrap(store: ResultStore) {
  const old = bootstrap(store) ?? {
    version: 2 as const,
    revision: 0,
    phase: "markers" as const,
    cursor: "legacyResultsWithheld:",
  };
  pending(Number.isSafeInteger(old.revision + 1));
  store.set(bootstrapKey, { ...old, revision: old.revision + 1 });
}
