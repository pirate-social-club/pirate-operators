import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializedLegacy,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  amount,
  bytes32,
  canonical,
  hashJson,
  insist,
} from "../community/common.ts";
import { address } from "../community/manifest-core.ts";
import {
  configureBudget,
  reserveBudget,
  settleBudget,
} from "../community/budgets.ts";
import {
  observeRootRegistration,
  rootRegistrationData,
  storyTestnet,
  type RootRegistrationInput,
} from "../community/registration-chain.ts";
import type { RegistrationReceipt } from "../community/post-manifest.ts";

export interface RegistrationGrant {
  sha256: Hex;
  period: string;
  operator: Address;
  recipient: Address;
  contentSha256: Hex;
  maximumGas: string;
  maximumGasPrice: string;
  maximumTotalFee: string;
  expiresAt: number;
  codeHashes: { workflow: Hex; nft: Hex; registry: Hex };
}
interface SignedRegistration {
  raw: TransactionSerializedLegacy;
  hash: Hex;
  maximumFee: string;
}
interface Row {
  request_hash: string;
  grant_hash: string;
  state: string;
  prepared_json: string | null;
  result_json: string | null;
}
export type RegistrationStatus =
  | { state: "confirmed"; receipt: RegistrationReceipt }
  | { state: "uncertain"; transactionHash?: Hex };
/** Exactly one root mint under the grant. Signed bytes are persisted before the
 * first broadcast and reused after a missing response; no replacement nonce,
 * recipient, metadata or fee can enter a retry. */
export async function fundedRegistration(
  db: D1Database,
  id: Hex,
  grant: RegistrationGrant,
  input: RootRegistrationInput,
  client: PublicClient,
  signer: PrivateKeyAccount,
): Promise<RegistrationStatus> {
  bytes32(id);
  bytes32(grant.sha256);
  insist(
    address(signer.address.toLowerCase()) === grant.operator &&
      address(input.recipient) === grant.recipient &&
      input.contentSha256 === grant.contentSha256,
    "registration_grant_mismatch",
    403,
  );
  insist((await client.getChainId()) === 1315, "wrong_registration_chain", 503);
  const requestHash = hashJson({ grant, input }),
    countKeys = [
      {
        scope: `release:registration:${grant.sha256}`,
        period: grant.period,
        asset: "root_mints",
      },
    ],
    feeKeys = [
      {
        scope: `release:registration:${grant.sha256}`,
        period: grant.period,
        asset: "native_wei",
      },
    ];
  await configureBudget(db, countKeys[0]!, "1");
  await configureBudget(db, feeKeys[0]!, grant.maximumTotalFee);
  await reserveBudget(db, id + ":mint", requestHash, countKeys, "1");
  await reserveBudget(
    db,
    id + ":fee",
    requestHash,
    feeKeys,
    grant.maximumTotalFee,
  );
  await db
    .prepare(
      "INSERT INTO funded_registrations(operation_id,request_hash,grant_hash,state,created_at) VALUES(?,?,?,'planned',?) ON CONFLICT DO NOTHING",
    )
    .bind(id, requestHash, grant.sha256, Date.now())
    .run();
  const load = async () => {
    const row = await db
      .prepare("SELECT * FROM funded_registrations WHERE operation_id=?")
      .bind(id)
      .first<Row>();
    insist(
      row &&
        row.request_hash === requestHash &&
        row.grant_hash === grant.sha256,
      "registration_intent_changed",
      409,
    );
    return row;
  };
  let row = await load();
  if (row.state === "planned") {
    insist(
      Math.floor(Date.now() / 1000) < grant.expiresAt,
      "registration_grant_expired",
      409,
    );
    const head = await client.getBlockNumber({ cacheTime: 0 });
    insist(head > 0n, "registration_chain_unavailable", 503);
    for (const key of ["workflow", "nft", "registry"] as const) {
      const code = await client.getCode({
        address: storyTestnet[key],
        blockNumber: head - 1n,
      });
      insist(
        code && keccak256(code) === grant.codeHashes[key],
        "registration_code_changed",
        503,
      );
    }
    const [nonce, pending, gasPrice, balance] = await Promise.all([
      client.getTransactionCount({
        address: grant.operator,
        blockTag: "latest",
      }),
      client.getTransactionCount({
        address: grant.operator,
        blockTag: "pending",
      }),
      client.getGasPrice(),
      client.getBalance({ address: grant.operator }),
    ]);
    insist(nonce === pending, "registration_operator_not_quiescent", 409);
    insist(
      gasPrice > 0n && gasPrice <= amount(grant.maximumGasPrice),
      "registration_gas_price_exceeds_cap",
      409,
    );
    const data = rootRegistrationData(input),
      estimate = await client.estimateGas({
        account: signer.address,
        to: storyTestnet.workflow,
        data,
        value: 0n,
      }),
      gas = (estimate * 120n + 99n) / 100n,
      fee = gas * gasPrice;
    insist(
      gas <= amount(grant.maximumGas) &&
        fee <= amount(grant.maximumTotalFee) &&
        balance >= fee,
      "registration_fee_exceeds_cap",
      409,
    );
    const raw = await signer.signTransaction({
        type: "legacy",
        chainId: 1315,
        nonce,
        to: storyTestnet.workflow,
        data,
        value: 0n,
        gas,
        gasPrice,
      }),
      prepared = { raw, hash: keccak256(raw), maximumFee: fee.toString() };
    await db
      .prepare(
        "UPDATE funded_registrations SET state='prepared',prepared_json=? WHERE operation_id=? AND state='planned'",
      )
      .bind(canonical(prepared), id)
      .run();
    row = await load();
  }
  insist(row.prepared_json, "registration_preparation_missing", 503);
  const prepared = JSON.parse(row.prepared_json) as SignedRegistration,
    tx = parseTransaction(prepared.raw);
  insist(
    tx.type === "legacy" && tx.gas !== undefined && tx.gasPrice !== undefined,
    "registration_signed_intent_changed",
    503,
  );
  insist(
    keccak256(prepared.raw) === prepared.hash &&
      Number(tx.chainId) === 1315 &&
      tx.to?.toLowerCase() === storyTestnet.workflow &&
      (tx.value ?? 0n) === 0n &&
      tx.data === rootRegistrationData(input) &&
      tx.gas <= amount(grant.maximumGas) &&
      tx.gasPrice <= amount(grant.maximumGasPrice) &&
      tx.gas * tx.gasPrice === amount(prepared.maximumFee) &&
      amount(prepared.maximumFee) <= amount(grant.maximumTotalFee) &&
      (
        await recoverTransactionAddress({
          serializedTransaction: prepared.raw,
        })
      ).toLowerCase() === grant.operator,
    "registration_signed_intent_changed",
    503,
  );
  const accept = async (receipt: RegistrationReceipt) => {
    const chainReceipt = await client.getTransactionReceipt({
      hash: prepared.hash,
    });
    insist(
      chainReceipt.blockHash === receipt.blockHash &&
        chainReceipt.status === "success",
      "registration_fee_receipt_changed",
      503,
    );
    const actual = chainReceipt.gasUsed * chainReceipt.effectiveGasPrice;
    insist(
      actual <= amount(prepared.maximumFee),
      "registration_actual_fee_exceeds_cap",
      503,
    );
    await db
      .prepare(
        "UPDATE funded_registrations SET state='confirmed',result_json=? WHERE operation_id=? AND state IN ('prepared','running','uncertain')",
      )
      .bind(canonical(receipt), id)
      .run();
    const saved = await load();
    insist(
      saved.state === "confirmed" && saved.result_json === canonical(receipt),
      "registration_receipt_changed",
      503,
    );
    await settleBudget(db, id + ":mint", countKeys, "1");
    await settleBudget(db, id + ":fee", feeKeys, actual.toString());
    return { state: "confirmed" as const, receipt };
  };
  const observed = await observeRootRegistration(
    client,
    prepared.hash,
    grant.operator,
    input,
  );
  if (observed) return accept(observed);
  // A confirmed receipt disappearing is a reorg/unavailable chain, never a new
  // operation. Keep its original signed hash and fail closed.
  if (
    row.state === "confirmed" ||
    Math.floor(Date.now() / 1000) >= grant.expiresAt
  )
    return { state: "uncertain", transactionHash: prepared.hash };
  const claimed = await db
    .prepare(
      "UPDATE funded_registrations SET state='running' WHERE operation_id=? AND state IN ('prepared','running','uncertain') RETURNING operation_id",
    )
    .bind(id)
    .first();
  insist(claimed, "registration_operation_changed", 409);
  try {
    const sent = await client.sendRawTransaction({
      serializedTransaction: prepared.raw,
    });
    insist(sent === prepared.hash, "registration_broadcast_hash_mismatch", 503);
  } catch {
    /* Unknown broadcasts are reconciled by the same hash and signed bytes. */
  }
  const receipt = await observeRootRegistration(
    client,
    prepared.hash,
    grant.operator,
    input,
  );
  if (receipt) return accept(receipt);
  await db
    .prepare(
      "UPDATE funded_registrations SET state='uncertain' WHERE operation_id=? AND state='running'",
    )
    .bind(id)
    .run();
  return { state: "uncertain", transactionHash: prepared.hash };
}
