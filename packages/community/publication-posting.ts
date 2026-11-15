import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionNotFoundError,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type PublicClient,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import { catalogOwner } from "./owner-policy.ts";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  amount,
  bytes32,
  canonical,
  CommunityError,
  insist,
  object,
} from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import {
  publicationData,
  observePublication,
  postsAbi,
  verifiedPostsHead,
  type PostsProfile,
  type FirstPublication,
} from "./post-chain.ts";
import { syncPublicPosts, indexedPublicPosts } from "./post-index.ts";
import { configureBudget, reserveBudget, settleBudget } from "./budgets.ts";
import {
  reserveOwnerBudget,
  settleOwnerBudget,
  type OwnerBudgetGrant,
} from "../release/owner-grant.ts";
import type { ExternalOperation } from "./publication-store.ts";
import {
  preparedOperation,
  type OperationResult,
  type PreparedOperation,
  type Reconciliation,
} from "./publication.ts";

export interface PostingBounds {
  period: string;
  maximumGas: string;
  maximumGasPrice: string;
  maximumTotalFee: string;
  expiresAt: number;
}
export interface PostingPorts {
  db: D1Database;
  client: PublicClient;
  publisher: PrivateKeyAccount;
  profile: PostsProfile;
  config: CommunityConfig;
  currentConfiguration(): Promise<CommunityConfig>;
  bounds: PostingBounds;
  /** Owner jobs spend post fees from the bounded owner grant. */
  ownerGrant?: OwnerBudgetGrant;
  /** Mandatory for the new policy, called after all async fee/RPC checks at send. */
  catalogBeforeBroadcast?():Promise<void>;
}
function intent(operation: ExternalOperation): FirstPublication {
  const request = object(JSON.parse(operation.request_json)),
    publication = object(request.publication);
  return {
    communityId: bytes32(publication.communityId),
    postId: bytes32(publication.postId),
    authorId: bytes32(publication.authorId),
    configurationRevision: Number(publication.configurationRevision),
    manifestSha256: bytes32(publication.manifestSha256),
    manifestURI: String(publication.manifestURI),
  };
}
async function authorize(ports: PostingPorts) {
  const fresh = await ports.currentConfiguration();
  insist(
    canonical(fresh) === canonical(ports.config) &&
      ports.publisher.address.toLowerCase() === fresh.publisher,
    "publication_authority_changed",
    403,
  );
  insist(
    Math.floor(Date.now() / 1000) < ports.bounds.expiresAt,
    "publication_window_expired",
    409,
  );
}
export async function preparePosting(
  operation: ExternalOperation,
  ports: PostingPorts,
): Promise<PreparedOperation> {
  await authorize(ports);
  const publication = intent(operation),
    head = await verifiedPostsHead(ports.client, ports.profile, ports.config);
  // A pre-existing exact stable post is observed, never purchased again.
  let exists = false;
  try {
    const row = await ports.client.readContract({
      address: ports.profile.address,
      abi: postsAbi,
      functionName: "getPost",
      args: [publication.communityId, publication.postId],
      blockNumber: head,
    });
    exists = true;
    insist(
      row.revision === 1n &&
        row.authorId === publication.authorId &&
        row.configurationRevision ===
          BigInt(publication.configurationRevision) &&
        row.manifestSha256 === publication.manifestSha256 &&
        row.manifestURI === publication.manifestURI,
      "existing_post_conflict",
      409,
    );
  } catch (error) {
    const cause =
      error instanceof BaseError
        ? error.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;
    if (
      !(
        cause instanceof ContractFunctionRevertedError &&
        cause.data?.errorName === "UnknownPost"
      )
    )
      throw error;
  }
  if (exists) {
    const scan = await syncPublicPosts(
      ports.db,
      ports.client,
      ports.profile,
      [ports.config],
      ports.config,
    );
    insist(scan.caughtUp, "public_index_catching_up", 503);
    const rows = await indexedPublicPosts(
      ports.db,
      ports.client,
      ports.profile,
      [ports.config],
      ports.config,
      scan.head,
      publication.postId,
    );
    insist(rows.length === 1, "existing_post_receipt_missing", 503);
    return {
      replay: { kind: "never" },
      payload: { alreadyPublishedHash: rows[0]!.transactionHash },
    };
  }
  const address = ports.publisher.address,
    [nonce, pending, gasPrice, balance] = await Promise.all([
      ports.client.getTransactionCount({ address, blockTag: "latest" }),
      ports.client.getTransactionCount({ address, blockTag: "pending" }),
      ports.client.getGasPrice(),
      ports.client.getBalance({ address }),
    ]);
  insist(nonce === pending, "publication_operator_not_quiescent", 409);
  const data = publicationData(publication),
    estimate = await ports.client.estimateGas({
      account: address,
      to: ports.profile.address,
      data,
      value: 0n,
    }),
    gas = (estimate * 120n + 99n) / 100n,
    maximumFee = gas * gasPrice;
  insist(
    gas > 0n &&
      gas <= amount(ports.bounds.maximumGas) &&
      gasPrice > 0n &&
      gasPrice <= amount(ports.bounds.maximumGasPrice) &&
      maximumFee <= amount(ports.bounds.maximumTotalFee) &&
      balance >= maximumFee,
    "publication_fee_exceeds_cap",
    409,
  );
  const raw = await ports.publisher.signTransaction({
    type: "legacy",
    chainId: 6343,
    nonce,
    to: ports.profile.address,
    data,
    value: 0n,
    gas,
    gasPrice,
  });
  return {
    replay: {
      kind: "same_signed_transaction",
      signedTransaction: raw,
      transactionHash: keccak256(raw),
    },
    payload: { maximumFee: maximumFee.toString() },
  };
}
async function signed(operation: ExternalOperation, ports: PostingPorts) {
  const prepared = preparedOperation(operation);
  insist(
    prepared.replay.kind === "same_signed_transaction",
    "publication_signed_intent_missing",
    503,
  );
  const raw = prepared.replay.signedTransaction as TransactionSerializedLegacy,
    tx = parseTransaction(raw),
    publication = intent(operation);
  insist(
    tx.type === "legacy" &&
      tx.gas !== undefined &&
      tx.gasPrice !== undefined &&
      Number(tx.chainId) === 6343 &&
      tx.to?.toLowerCase() === ports.profile.address &&
      tx.data === publicationData(publication) &&
      (tx.value ?? 0n) === 0n &&
      tx.gas <= amount(ports.bounds.maximumGas) &&
      tx.gasPrice <= amount(ports.bounds.maximumGasPrice) &&
      tx.gas * tx.gasPrice === amount(prepared.payload.maximumFee) &&
      tx.gas * tx.gasPrice <= amount(ports.bounds.maximumTotalFee) &&
      (
        await recoverTransactionAddress({ serializedTransaction: raw })
      ).toLowerCase() === ports.config.publisher,
    "publication_signed_intent_changed",
    503,
  );
  return {
    raw,
    hash: prepared.replay.transactionHash,
    nonce: tx.nonce!,
    maximumFee: String(prepared.payload.maximumFee),
  };
}
const budgetKeys = (ports: PostingPorts, asset: string) => [
  {
    scope: `publication:${ports.config.communityId}`,
    period: ports.bounds.period,
    asset,
  },
];
async function observed(
  operation: ExternalOperation,
  ports: PostingPorts,
): Promise<OperationResult | null> {
  const prepared = preparedOperation(operation),
    hash =
      prepared.replay.kind === "same_signed_transaction"
        ? prepared.replay.transactionHash
        : bytes32(prepared.payload.alreadyPublishedHash),
    value = await observePublication(
      ports.client,
      ports.profile,
      ports.config,
      hash,
      ports.config.publisher,
      intent(operation),
    );
  if (!value) return null;
  if (prepared.replay.kind === "same_signed_transaction") {
    const receipt = await ports.client.getTransactionReceipt({ hash });
    insist(
      receipt.blockHash === value.blockHash && receipt.status === "success",
      "publication_fee_receipt_changed",
      503,
    );
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    insist(
      cost <= amount(prepared.payload.maximumFee),
      "publication_actual_fee_exceeds_cap",
      503,
    );
    if (ports.ownerGrant)
      // Needs only the reservation, so it also settles after the window ends.
      await settleOwnerBudget(
        ports.db,
        ports.ownerGrant,
        "post_fee_wei",
        operation.operation_id + ":fee",
        cost.toString(),
      );
    else {
      await settleBudget(
        ports.db,
        operation.operation_id + ":count",
        budgetKeys(ports, "post_transactions"),
        "1",
      );
      await settleBudget(
        ports.db,
        operation.operation_id + ":fee",
        budgetKeys(ports, "native_wei"),
        cost.toString(),
      );
    }
  }
  return { kind: "confirmed", providerId: hash, value };
}
const ownerPostingRefusals = new Set([
  "funding_cap_exhausted",
  "owner_budget_window_not_current",
  "owner_budget_window_overlap",
  "owner_budget_window_superseded",
  "owner_budget_limits_changed",
  "budget_profile_changed",
  "owner_grant_outside_window",
]);
const ownerPostingRefusal = (error: unknown): error is CommunityError =>
  error instanceof CommunityError &&
  (error.status === 403 || error.status === 409) &&
  ownerPostingRefusals.has(error.code);
async function feeReserved(operation: ExternalOperation, ports: PostingPorts) {
  return Boolean(
    await ports.db
      .prepare(
        "SELECT 1 AS present FROM spending_reservations WHERE reservation_id=?",
      )
      .bind(operation.operation_id + ":fee")
      .first(),
  );
}
export async function executePosting(
  operation: ExternalOperation,
  ports: PostingPorts,
): Promise<OperationResult> {
  const prepared = preparedOperation(operation);
  if (prepared.replay.kind === "never") {
    const result = await observed(operation, ports);
    insist(result, "publication_pending", 503);
    return result;
  }
  const tx = await signed(operation, ports);
  if (ports.ownerGrant) {
    // A replayed reservation returns before any grant check, so an operation
    // that may have broadcast keeps its reconciliation path. A refusal means
    // no reservation exists for this operation, and none is ever made before
    // broadcast: the transaction was never sent, so the job holds.
    try {
      await reserveOwnerBudget(
        ports.db,
        ports.ownerGrant,
        "post_fee_wei",
        operation.operation_id + ":fee",
        operation.request_hash,
        tx.maximumFee,
      );
    } catch (error) {
      if (!ownerPostingRefusal(error)) throw error;
      return {
        kind: "held",
        providerId: operation.operation_id + ":fee",
        code: error.code,
        value: { serviceState: "refused", errorCode: error.code },
      };
    }
  } else {
    await configureBudget(
      ports.db,
      budgetKeys(ports, "post_transactions")[0]!,
      "1",
    );
    await configureBudget(
      ports.db,
      budgetKeys(ports, "native_wei")[0]!,
      ports.bounds.maximumTotalFee,
    );
    await reserveBudget(
      ports.db,
      operation.operation_id + ":count",
      operation.request_hash,
      budgetKeys(ports, "post_transactions"),
      "1",
    );
    await reserveBudget(
      ports.db,
      operation.operation_id + ":fee",
      operation.request_hash,
      budgetKeys(ports, "native_wei"),
      tx.maximumFee,
    );
  }
  const already = await observed(operation, ports);
  if (already) return already;
  await authorize(ports);
  if (catalogOwner(ports.config.policies.admission)) {
    insist(ports.catalogBeforeBroadcast,"catalog_pending",503);
    await ports.catalogBeforeBroadcast();
  }
  try {
    const hash = await ports.client.sendRawTransaction({
      serializedTransaction: tx.raw,
    });
    insist(hash === tx.hash, "publication_broadcast_hash_mismatch", 503);
  } catch {
    /* Reconcile the same signed hash before any retry. */
  }
  const result = await observed(operation, ports);
  insist(result, "publication_pending", 503);
  return result;
}
export async function reconcilePosting(
  operation: ExternalOperation,
  ports: PostingPorts,
): Promise<Reconciliation> {
  const result = await observed(operation, ports);
  if (result) return result;
  const prepared = preparedOperation(operation);
  if (prepared.replay.kind !== "same_signed_transaction")
    return { kind: "unknown" };
  const tx = await signed(operation, ports);
  try {
    await ports.client.getTransaction({ hash: tx.hash });
    return { kind: "unknown" };
  } catch (error) {
    if (!(error instanceof TransactionNotFoundError)) throw error;
  }
  const [latest, pending] = await Promise.all([
    ports.client.getTransactionCount({
      address: ports.config.publisher,
      blockTag: "latest",
    }),
    ports.client.getTransactionCount({
      address: ports.config.publisher,
      blockTag: "pending",
    }),
  ]);
  if (latest > tx.nonce || pending > tx.nonce) return { kind: "unknown" };
  return {
    kind: "absent",
    proof: canonical({
      chainId: 6343,
      transactionHash: tx.hash,
      nonce: tx.nonce,
      latest,
      pending,
    }),
  };
}
export async function validatePosting(
  operation: ExternalOperation,
  ports: PostingPorts,
  result: OperationResult,
) {
  // A held owner refusal is proven only while no fee reservation exists for
  // the operation: nothing is broadcast without one.
  if (result.kind === "held") {
    insist(
      ports.ownerGrant &&
        ownerPostingRefusals.has(result.code) &&
        !(await feeReserved(operation, ports)),
      "publication_result_mismatch",
      503,
    );
    return;
  }
  const actual = await observed(operation, ports);
  insist(
    actual && canonical(actual) === canonical(result),
    "publication_result_mismatch",
    503,
  );
}
