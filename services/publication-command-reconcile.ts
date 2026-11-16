import { keccak256, parseTransaction, recoverTransactionAddress, type Hex,
  type TransactionSerializedLegacy } from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import type { ConsentCommandReceiptV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { clearPublicationReceipt, intentOf, notePublicationReceipt, txRow, type TxRow } from "./operator-tx.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { same, preparedCall, byteHex, record, publicationDisposition } from "./publication-command-contract.ts";
import { queuedReceipt, readPublicationJob, type PublicationCommandJob } from "./publication-command-operator.ts";
import { verifyPublicationCommandEvent, type PublicationRpcReceipt } from "./publication-command-events.ts";
import type { PublicationReadRpc } from "./publication-command-rpc.ts";

interface Block {number:Hex;hash:Hex;timestamp:Hex;transactions:Hex[]}
interface Transaction {hash:Hex;from:string;to:string|null;input:Hex;nonce:Hex;
  value:Hex;blockHash:Hex|null;blockNumber:Hex|null;transactionIndex:Hex|null}
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const quantity = (x: unknown) => {
  check(typeof x === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)(?![\s\S])/.test(x),
    "publication_rpc_quantity_invalid");
  return BigInt(x);
};
function header(value: unknown, expectedNumber?: bigint): Block {
  const b = record(value);
  const hash = (value: unknown) => {
    try { return consentDigest(value); }
    catch { check(false, "publication_block_hash_invalid"); }
  };
  hash(b.hash); quantity(b.number); quantity(b.timestamp);
  check(expectedNumber === undefined || quantity(b.number) === expectedNumber,
    "publication_block_changed");
  check(Array.isArray(b.transactions), "publication_block_transactions_invalid");
  for (const transactionHash of b.transactions) hash(transactionHash);
  return b as unknown as Block;
}
function legacy(raw: Hex): asserts raw is TransactionSerializedLegacy {
  check(parseTransaction(raw).type === "legacy" && /^0x[cdef]/.test(raw),
    "publication_original_type_changed");
}
const identity = (row: TxRow) => digest({nonce:row.nonce,kind:row.kind,ref:row.ref,
  chainId:row.chainId,to:row.to,data:row.data,gas:row.gas,gasPrice:row.gasPrice,
  raw:row.raw??null,hash:row.hash??null,publicationV1:row.publicationV1??null});
function audit(store: ResultStore, id: Hex, value: Record<string,unknown>) {
  const key = "publicationV1Observation:"+id+":"+digest(value);
  const old = store.get<unknown>(key);
  if (old !== undefined) check(same(old,value), "publication_audit_changed");
  else store.set(key,value);
}
async function original(job: PublicationCommandJob, row: TxRow) {
  const c = job.command;
  check(row.kind === job.kind && row.ref === job.ref && row.chainId === c.source.chainId &&
    row.to === c.source.registry && row.data === job.data && same(row.publicationV1,job.fee) &&
    row.raw && row.hash && keccak256(byteHex(row.raw)) === row.hash && !row.authorizationList,
    "publication_original_changed");
  check(preparedCall(c,job.signature).data === row.data, "publication_original_changed");
  const raw = byteHex(row.raw); legacy(raw);
  const parsed = parseTransaction(raw);
  const payer = await recoverTransactionAddress({serializedTransaction:raw});
  check(parsed.chainId === row.chainId && parsed.nonce === row.nonce &&
    parsed.to?.toLowerCase() === row.to && parsed.data === row.data &&
    (parsed.value??0n) === 0n && parsed.gas === BigInt(row.gas) &&
    parsed.gasPrice === BigInt(row.gasPrice) && payer.toLowerCase() === job.fee.payer,
    "publication_original_signature_changed");
}
/** Original-only reads. No fee/send admission or current descriptor needed. */
export async function reconcilePublicationCommand(store: ResultStore, id: Hex,
  read: PublicationReadRpc): Promise<ConsentCommandReceiptV1> {
  const job = readPublicationJob(store,id);
  check(job, "publication_command_missing");
  const base = queuedReceipt(job), intent = intentOf(store,job.kind,job.ref);
  check(intent && intent.to === job.command.source.registry && intent.data === job.data &&
    same(intent.publicationV1,job.fee), "publication_intent_changed");
  if (intent.nonce === null) {
    check(!store.entries("tx:").some(({value}) => {
      const tx = value as TxRow; return tx.kind === job.kind && tx.ref === job.ref;
    }), "publication_orphan_transaction");
    return base;
  }
  const row = txRow(store,intent.nonce);
  check(row, "publication_original_missing");
  const fingerprint = identity(row);
  let expected = publicationDisposition(row);
  if (!row.raw || !row.hash) return {...base,state:"pending"};
  await original(job,row);
  const hash = row.hash;
  check(quantity(await read<Hex>("eth_chainId",[])) === BigInt(job.command.source.chainId),
    "publication_chain_changed");
  const currentRow = () => {
    const current = txRow(store,row.nonce);
    check(current && identity(current) === fingerprint, "publication_original_changed");
    return current;
  };
  const clearOrphanedPrevious = async (known?: Block) => {
    const previous = row.publicationReceipt;
    if (!previous) return;
    const response = known && quantity(known.number) === BigInt(previous.blockNumber) ? known :
      await read<unknown>("eth_getBlockByNumber",[hex(BigInt(previous.blockNumber)),false]);
    if (response === null) return; // Unavailable is not demonstrated reorg.
    const old = header(response,BigInt(previous.blockNumber));
    if (old.hash === previous.blockHash) return;
    const applied = store.transaction(() => {
      const current = currentRow(), disposition = publicationDisposition(current);
      const observed = {state:"reorg",commandId:id,old:previous,canonical:old.hash,
        priorNonceDisposition:current.mined,priorCancellation:current.cancellation??null,
        priorReceipt:current.publicationReceipt??null,priorRevision:disposition.revision};
      if (disposition.revision < Number.MAX_SAFE_INTEGER) audit(store,id,observed);
      const changed = clearPublicationReceipt(store,row.nonce,previous.proofHash,expected);
      if (changed) expected = publicationDisposition(currentRow());
      return changed;
    });
    // The stale audit has committed even when this worker lost the CAS.
    check(applied,"publication_observation_raced");
  };
  const receipt = await read<PublicationRpcReceipt|null>("eth_getTransactionReceipt",[hash]);
  if (!receipt) {
    await clearOrphanedPrevious();
    return {...base,transactionHash:hash,state:"unknown"};
  }
  check(receipt.transactionHash === hash && receipt.to?.toLowerCase() === row.to &&
    receipt.from.toLowerCase() === job.fee.payer, "publication_receipt_changed");
  const blockNumber = quantity(receipt.blockNumber), txIndex = quantity(receipt.transactionIndex);
  const status = quantity(receipt.status);
  check(status === 0n || status === 1n,"publication_receipt_status_invalid");
  const [transaction,blockValue,safeValue] = await Promise.all([
    read<Transaction|null>("eth_getTransactionByHash",[hash]),
    read<unknown>("eth_getBlockByNumber",[receipt.blockNumber,false]),
    read<unknown>("eth_getBlockByNumber",["safe",false]),
  ]);
  check(transaction, "publication_receipt_unavailable");
  const block = header(blockValue,blockNumber), safe = header(safeValue);
  await clearOrphanedPrevious(block);
  check(block.hash === receipt.blockHash &&
    transaction.hash === hash && transaction.from.toLowerCase() === job.fee.payer &&
    transaction.to?.toLowerCase() === row.to && transaction.input === row.data &&
    quantity(transaction.nonce) === BigInt(row.nonce) && quantity(transaction.value) === 0n &&
    transaction.blockHash === block.hash && transaction.blockNumber === receipt.blockNumber &&
    transaction.transactionIndex === receipt.transactionIndex &&
    txIndex <= BigInt(Number.MAX_SAFE_INTEGER) && block.transactions[Number(txIndex)] === hash,
    "publication_canonical_receipt_changed");
  if (status === 1n) {
    // EIP-1898 binds historical code to this exact canonical receipt hash.
    // Unsupported hash lookup is unavailable; there is no numbered fallback.
    const code = await read<Hex>("eth_getCode",[row.to,
      {blockHash:block.hash,requireCanonical:true}]);
    check(keccak256(byteHex(code)) === job.command.source.registryRuntimeHash,
      "publication_original_runtime_changed");
    verifyPublicationCommandEvent(job,receipt,quantity(block.timestamp));
  }
  if (quantity(safe.number) < blockNumber)
    return {...base,transactionHash:hash,state:"pending"};
  const [againValue,safeAgainValue] = await Promise.all([
    read<unknown>("eth_getBlockByNumber",[receipt.blockNumber,false]),
    read<unknown>("eth_getBlockByNumber",[safe.number,false]),
  ]);
  const again = header(againValue,blockNumber);
  const safeAgain = header(safeAgainValue,quantity(safe.number));
  check(again.hash === block.hash && again.timestamp === block.timestamp &&
    safeAgain.hash === safe.hash && safeAgain.timestamp === safe.timestamp,
    "publication_canonical_receipt_changed");
  const result: ConsentCommandReceiptV1 = {...base,transactionHash:hash,
    state:status === 1n ? "recorded" : "reverted",transactionIndex:Number(txIndex),
    observed:{blockNumber:String(blockNumber),blockHash:block.hash,
      timestampS:String(quantity(block.timestamp))}};
  const proof = {proofHash:digest(result),blockHash:block.hash,blockNumber:String(blockNumber),
    state:status === 1n ? "recorded" as const : "reverted" as const};
  const applied = store.transaction(() => {
    const current = currentRow(), disposition = publicationDisposition(current);
    // Prior disposition is read HERE, never from the pre-await row.
    const already = same(current.publicationReceipt??null,proof) &&
      current.mined?.status === (status === 1n ? "success" : "reverted") &&
      current.mined.block === Number(blockNumber);
    if (!already && disposition.revision < Number.MAX_SAFE_INTEGER)
      audit(store,id,{result,receipt,priorNonceDisposition:current.mined,
        priorCancellation:current.cancellation??null,priorReceipt:current.publicationReceipt??null,
        priorRevision:disposition.revision});
    return notePublicationReceipt(store,row.nonce,hash,proof,expected);
  });
  check(applied,"publication_observation_raced");
  return result;
}
