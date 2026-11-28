import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializedEIP1559,
} from "viem";
import { canonical, exact, hashText, insist, object } from "./common.ts";
import { address } from "./manifest-core.ts";
import { directoryV3Abi } from "./web2-directory.ts";
import {
  safeView,
  assertFreshBlock,
  wei,
  type Enrollment,
  type HostedPolicy,
} from "./hosted-enrollment.ts";
import {
  bindWeb2RegistrationTransaction,
  observeWeb2Registration,
} from "./web2-registration-chain.ts";
import {
  claimDispatch,
  createOperation,
  getOperation,
  persistSigned,
  reserveOperation,
  settleOperation,
  requireActive,
  type HostedOperation,
  type HostedSchemaContext,
} from "./hosted-enrollment-store.ts";

export interface HostedUnsignedTransaction {
  type: "eip1559";
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export interface HostedSigner {
  address: Address;
  /** Signing only. Must not broadcast, allocate a nonce, or adjust any field. */
  signTransaction(transaction: HostedUnsignedTransaction): Promise<Hex>;
}
export interface HostedRuntime {
  readonly schemaContext?: HostedSchemaContext;
  db: D1Database;
  policy: Readonly<HostedPolicy>;
  client: PublicClient;
  now: () => number;
  registrar: HostedSigner;
  funder: HostedSigner;
  /** Retrieve public immutable configuration bytes through the selected pin service. */
  readConfiguration: (uri: string) => Promise<Response>;
  /** Optional injection point for tests of the real public HTTPS installation readback. */
  readInstallation?: typeof fetch;
}
interface TransferIntent {
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  extraFeeCeiling: string;
}
export function initialRecipients(
  e: Enrollment,
  p: HostedPolicy,
): { address: Address; value: bigint }[] {
  const c = e.plan.config.controller,
    b = e.plan.config.publisher;
  if (c === b)
    return [
      {
        address: c,
        value:
          wei(p.controllerInitialWei) > wei(p.publisherInitialWei)
            ? wei(p.controllerInitialWei)
            : wei(p.publisherInitialWei),
      },
    ];
  return [
    { address: c, value: wei(p.controllerInitialWei) },
    { address: b, value: wei(p.publisherInitialWei) },
  ];
}
function intent(
  e: Enrollment,
  p: HostedPolicy,
  kind: HostedOperation["kind"],
  recipient?: Address,
): TransferIntent {
  if (kind === "registration")
    return {
      to: e.plan.profile.directory,
      data: e.plan.data,
      value: "0",
      gas: p.registrationGas,
      maxFeePerGas: p.maxFeePerGas,
      maxPriorityFeePerGas: p.maxPriorityFeePerGas,
      extraFeeCeiling: p.extraFeeCeiling,
    };
  const r = initialRecipients(e, p).find((x) => x.address === recipient);
  insist(r && r.value > 0n, "initial_recipient_not_admitted", 403);
  return {
    to: r.address,
    data: "0x",
    value: String(r.value),
    gas: p.topupGas,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    extraFeeCeiling: p.extraFeeCeiling,
  };
}
export function unsignedOperation(
  op: HostedOperation,
): HostedUnsignedTransaction {
  const t = object(JSON.parse(op.payload));
  exact(t, [
    "to",
    "data",
    "value",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "extraFeeCeiling",
  ]);
  insist(
    typeof t.data === "string" &&
      /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(t.data),
    "invalid_hosted_calldata",
  );
  return {
    type: "eip1559",
    chainId: op.chain_id,
    to: address(t.to),
    data: t.data as Hex,
    value: wei(t.value),
    nonce: op.nonce,
    gas: wei(t.gas),
    maxFeePerGas: wei(t.maxFeePerGas),
    maxPriorityFeePerGas: wei(t.maxPriorityFeePerGas),
  };
}
export async function authenticateOriginal(op: HostedOperation) {
  const original = Object.freeze({ ...op }),
    expected = unsignedOperation(original);
  insist(
    original.raw &&
      original.tx_hash &&
      keccak256(original.raw) === original.tx_hash,
    "hosted_original_hash_mismatch",
    503,
  );
  const raw = original.raw,
    parsed = parseTransaction(raw);
  insist(
    parsed.type === "eip1559" &&
      parsed.chainId === expected.chainId &&
      parsed.to?.toLowerCase() === expected.to &&
      (parsed.data ?? "0x") === expected.data &&
      (parsed.value ?? 0n) === expected.value &&
      parsed.nonce === expected.nonce &&
      parsed.gas === expected.gas &&
      parsed.maxFeePerGas === expected.maxFeePerGas &&
      parsed.maxPriorityFeePerGas === expected.maxPriorityFeePerGas &&
      (parsed.accessList?.length ?? 0) === 0,
    "hosted_original_payload_mismatch",
    503,
  );
  insist(
    (
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerializedEIP1559,
      })
    ).toLowerCase() === original.sender,
    "hosted_original_sender_mismatch",
    503,
  );
  return original;
}
function extraFee(raw: unknown, p: HostedPolicy): bigint {
  const r = object(raw),
    value = r.l1Fee;
  if (p.extraFeeField === "none") {
    insist(
      value === undefined || value === null || value === "0x0",
      "unexpected_receipt_extra_fee",
      503,
    );
    return 0n;
  }
  insist(
    typeof value === "string" &&
      /^0x(0|[1-9a-f][0-9a-f]*)(?![\s\S])/.test(value),
    "receipt_extra_fee_unavailable",
    503,
  );
  const fee = BigInt(value);
  insist(
    fee <= wei(p.extraFeeCeiling),
    "receipt_extra_fee_exceeds_policy",
    503,
  );
  return fee;
}
export async function reconcileHostedOperation(
  r: HostedRuntime,
  e: Enrollment,
  input: HostedOperation,
) {
  if (input.state === "planned" || input.state === "signed") return input;
  const op = await authenticateOriginal(input),
    tx = unsignedOperation(op);
  const safe = await safeView(r.client, r.policy, r.now);
  let receipt;
  try {
    receipt = await r.client.getTransactionReceipt({ hash: op.tx_hash! });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      insist(op.state === "dispatched", "settled_receipt_unavailable", 503);
      return op;
    }
    throw error;
  }
  insist(
    receipt.transactionHash === op.tx_hash &&
      receipt.from.toLowerCase() === op.sender &&
      receipt.to?.toLowerCase() === tx.to,
    "hosted_receipt_identity_mismatch",
    503,
  );
  const block = await r.client.getBlock({ blockNumber: receipt.blockNumber });
  insist(block.hash === receipt.blockHash, "hosted_chain_reorganized", 503);
  if (receipt.blockNumber > safe.number) return op;
  if (op.kind === "registration") {
    const bound = await bindWeb2RegistrationTransaction(e.plan, op.raw!, tx);
    const observed = await observeWeb2Registration(r.client, bound);
    if (observed.status === "pending") return op;
    insist(
      observed.status ===
        (receipt.status === "success" ? "consumed" : "reverted"),
      "registration_receipt_disagrees",
      503,
    );
  }
  insist(
    receipt.status === "success" || receipt.status === "reverted",
    "unknown_receipt_status",
    503,
  );
  const raw = await r.client.request({
    method: "eth_getTransactionReceipt",
    params: [op.tx_hash!],
  });
  insist(
    raw &&
      raw.blockHash === receipt.blockHash &&
      raw.transactionHash === op.tx_hash,
    "receipt_changed",
    503,
  );
  const fee = extraFee(raw, r.policy),
    cost =
      receipt.gasUsed * receipt.effectiveGasPrice +
      fee +
      (receipt.status === "success" ? tx.value : 0n);
  const [again, confirmation] = await Promise.all([
    r.client.getBlock({ blockNumber: receipt.blockNumber }),
    r.client.getBlock({ blockNumber: safe.number }),
  ]);
  insist(
    again.hash === receipt.blockHash && confirmation.hash === safe.hash,
    "hosted_chain_reorganized",
    503,
  );
  await settleOperation(
    r.db,
    r.policy,
    e,
    op,
    tx.to,
    cost,
    receipt.status === "success" ? "consumed" : "reverted",
    {
      transactionHash: op.tx_hash,
      blockNumber: String(receipt.blockNumber),
      blockHash: receipt.blockHash,
      gasUsed: String(receipt.gasUsed),
      effectiveGasPrice: String(receipt.effectiveGasPrice),
      extraFee: String(fee),
      principal: receipt.status === "success" ? String(tx.value) : "0",
      cost: String(cost),
      chargedBoundWei: op.reservation,
    },
  );
  return (await getOperation(r.db, op.id))!;
}
export async function executeHostedOperation(
  r: HostedRuntime,
  e: Enrollment,
  kind: HostedOperation["kind"],
  recipient?: Address,
  beforeEffect?: () => Promise<void>,
) {
  const spec = intent(e, r.policy, kind, recipient),
    payload = canonical(spec),
    sender = kind === "registration" ? r.policy.registrar : r.policy.funder;
  const signer = kind === "registration" ? r.registrar : r.funder,
    id = `${e.id}:${kind}:${spec.to}`;
  insist(address(signer.address) === sender, "hosted_signer_mismatch", 503);
  const requestHash = hashText(
    canonical({
      enrollmentId: e.id,
      kind,
      sender,
      payload,
      chainId: e.plan.profile.chainId,
    }),
  );
  let op = await getOperation(r.db, id);
  if (op)
    insist(
      op.request_hash === requestHash && op.payload === payload,
      "hosted_operation_conflict",
      409,
    );
  if (
    op &&
    (op.state === "dispatched" ||
      op.state === "consumed" ||
      op.state === "reverted")
  ) {
    op = await reconcileHostedOperation(r, e, op);
    if (
      op.state !== "dispatched" ||
      op.attempts >= r.policy.maxBroadcastAttempts ||
      r.now() - (op.last_dispatch ?? r.now()) < r.policy.broadcastRetrySeconds
    )
      return op;
    // Receipt exists but is not safe: observe only, never rebroadcast.
    try {
      await r.client.getTransactionReceipt({ hash: op.tx_hash! });
      return op;
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
  }
  await requireActive(r.db, e, r.now());
  if (beforeEffect) await beforeEffect();
  const safe = await safeView(r.client, r.policy, r.now);
  // A real safe-state simulation occurs before reserving or signing. It is not
  // an inclusion guarantee; later reverts are still charged from their receipt.
  await r.client.call({
    account: sender,
    to: spec.to,
    data: spec.data,
    value: wei(spec.value),
    gas: wei(spec.gas),
    blockNumber: safe.number,
  });
  insist(
    (await r.client.getBlock({ blockNumber: safe.number })).hash === safe.hash,
    "hosted_chain_reorganized",
    503,
  );
  if (!op) {
    // Cap refusal must not allocate a nonce. This reservation is replay-safe;
    // a crash before allocation holds it conservatively for this original ID.
    const provisional: HostedOperation = {
      id,
      enrollment_id: e.id,
      kind,
      sender,
      chain_id: e.plan.profile.chainId,
      nonce: 0,
      payload,
      request_hash: requestHash,
      reservation: String(
        wei(spec.value) +
          wei(spec.gas) * wei(spec.maxFeePerGas) +
          wei(spec.extraFeeCeiling),
      ),
      raw: null,
      tx_hash: null,
      state: "planned",
      receipt: null,
      attempts: 0,
      last_dispatch: null,
    };
    await reserveOperation(r.db, r.policy, e, provisional, spec.to, r.now());
  }
  if (!op)
    op = await createOperation(
      r.db,
      e,
      r.now(),
      {
        id,
        enrollment_id: e.id,
        kind,
        sender,
        chain_id: e.plan.profile.chainId,
        payload,
        request_hash: requestHash,
        reservation: String(
          wei(spec.value) +
            wei(spec.gas) * wei(spec.maxFeePerGas) +
            wei(spec.extraFeeCeiling),
        ),
      },
      await r.client.getTransactionCount({
        address: sender,
        blockTag: "pending",
      }),
    );
  await reserveOperation(r.db, r.policy, e, op, spec.to, r.now());
  if (op.state === "planned") {
    await requireActive(r.db, e, r.now());
    const raw = await signer.signTransaction(unsignedOperation(op));
    await authenticateOriginal({ ...op, raw, tx_hash: keccak256(raw) });
    op = await persistSigned(r.db, op, raw, keccak256(raw));
  }
  op = await authenticateOriginal(op);
  const dispatchSafe = await safeView(r.client, r.policy, r.now);
  await r.client.call({
    account: sender,
    to: spec.to,
    data: spec.data,
    value: wei(spec.value),
    gas: wei(spec.gas),
    blockNumber: dispatchSafe.number,
  });
  if (kind === "topup") {
    const community = await r.client.readContract({
      address: e.plan.profile.directory,
      abi: directoryV3Abi,
      functionName: "getCommunity",
      args: [e.plan.profile.communityId],
      blockNumber: dispatchSafe.number,
    });
    insist(
      community.configuration.controller.toLowerCase() ===
        e.plan.config.controller &&
        community.configuration.publisher.toLowerCase() ===
          e.plan.config.publisher,
      "funding_roles_changed",
      409,
    );
  }
  insist(
    (await r.client.getBlock({ blockNumber: dispatchSafe.number })).hash ===
      dispatchSafe.hash,
    "hosted_chain_reorganized",
    503,
  );
  assertFreshBlock(safe, r.policy, r.now());
  assertFreshBlock(dispatchSafe, r.policy, r.now());
  if (await claimDispatch(r.db, e, op, r.now(), r.policy)) {
    assertFreshBlock(dispatchSafe, r.policy, r.now());
    await requireActive(r.db, e, r.now());
    assertFreshBlock(dispatchSafe, r.policy, r.now());
    // One submission per successful bounded attempt CAS. The durable
    // dispatched state deliberately does not assert whether the provider saw it.
    try {
      const hash = await r.client.sendRawTransaction({
        serializedTransaction: op.raw!,
      });
      insist(hash === op.tx_hash, "broadcast_hash_mismatch", 503);
    } catch {
      return (await getOperation(r.db, op.id))!;
    }
  }
  return reconcileHostedOperation(r, e, (await getOperation(r.db, op.id))!);
}
