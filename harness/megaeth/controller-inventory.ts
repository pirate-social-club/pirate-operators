// Read existing private state without creating a lock, database or journal.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { hashJson, insist } from "../../packages/community/common.ts";
import type { StudyCorrectionProfile } from "./study-correction-plan.ts";

export function privateExistingFile(path: string) {
  const info = lstatSync(path);
  insist(
    resolve(path) === path &&
      realpathSync(path) === path &&
      info.isFile() &&
      !(info.mode & 0o077) &&
      (!process.getuid || info.uid === process.getuid()),
    "controller_file_not_private_regular",
  );
  insist(info.size <= 16 * 1024 * 1024, "controller_file_too_large");
}
export const sha256File = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export function custodyScope(profile: StudyCorrectionProfile) {
  const { custody, ...scope } = profile;
  return hashJson({
    ...scope,
    custody: { ownerRole: custody.ownerRole, exclusions: custody.exclusions },
  });
}
export function readCustody(profile: StudyCorrectionProfile) {
  privateExistingFile(profile.custody.record);
  insist(
    sha256File(profile.custody.record) === profile.custody.sha256,
    "controller_custody_record_changed",
  );
  const record = JSON.parse(readFileSync(profile.custody.record, "utf8"));
  insist(
    record.schema === "pirate.controller-custody/1" &&
      record.scopeHash === custodyScope(profile) &&
      record.ownerRole === "workspace_coordinator" &&
      record.inventoryCompleteForWindow === true &&
      Array.isArray(record.quiescentWriters) &&
      record.quiescentWriters.length > 0 &&
      record.quiescentWriters.every(
        (x: unknown) => typeof x === "string" && x.length > 0,
      ) &&
      hashJson(record.exclusions) === hashJson(profile.custody.exclusions),
    "controller_custody_not_reconciled",
  );
  return {
    scopeHash: record.scopeHash as Hex,
    quiescentWriters: record.quiescentWriters as string[],
  };
}
interface Allocation {
  nonce: number;
  hash: Hex;
  raw: Hex;
  chainId?: number;
}
function allocations(
  profile: StudyCorrectionProfile,
  entry: StudyCorrectionProfile["inventory"][number],
): Allocation[] {
  privateExistingFile(entry.path);
  insist(
    sha256File(entry.path) === entry.sha256,
    "controller_inventory_changed",
  );
  let rows: Allocation[];
  if (entry.format === "activation-journal") {
    insist(
      !existsSync(entry.path + "-wal") &&
        !existsSync(entry.path + "-shm") &&
        !existsSync(entry.path + "-journal"),
      "controller_inventory_sidecar_unreviewed",
    );
    const db = new DatabaseSync(entry.path, { readOnly: true });
    try {
      const records = db
        .prepare("SELECT key,value FROM records ORDER BY key")
        .all() as { key: string; value: string }[];
      insist(records.length <= 10000, "controller_inventory_too_large");
      const saved = records.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value),
      }));
      insist(
        saved
          .filter((row) => row.key.startsWith("intent:"))
          .every((row) => Number.isSafeInteger(row.value.nonce)),
        "controller_unallocated_intent",
      );
      insist(
        saved
          .filter((row) => row.key === "sponsor:ledger")
          .every((row) => BigInt(row.value.reserved ?? "0") === 0n),
        "controller_unresolved_reservation",
      );
      insist(
        saved
          .filter((row) => row.key.startsWith("sponsor:reservation:"))
          .every((row) => row.value.state !== "reserved"),
        "controller_unresolved_reservation",
      );
      rows = saved
        .filter((row) => row.key.startsWith("tx:"))
        .map((row) => row.value);
      for (const intent of saved.filter((row) =>
        row.key.startsWith("intent:"),
      )) {
        const row = rows.find((row) => row.nonce === intent.value.nonce);
        insist(row?.raw && row.hash, "controller_intent_transaction_missing");
        const tx = parseTransaction(row.raw);
        insist(
          (intent.value.to === undefined ||
            tx.to?.toLowerCase() === intent.value.to.toLowerCase()) &&
            (intent.value.data === undefined || tx.data === intent.value.data),
          "controller_intent_transaction_changed",
        );
      }
      const own = saved.find((row) => row.key === "correction");
      if (own) {
        insist(
          /^0x[0-9a-f]{64}$/.test(own.value.profileHash),
          "controller_correction_profile_changed",
        );
        rows.push(own.value);
      }
    } finally {
      db.close();
    }
  } else {
    const state = JSON.parse(readFileSync(entry.path, "utf8"));
    if (entry.format === "deployment-journal-v1") {
      insist(
        state.schema === "pirate.testnet-deployment-journal/1" &&
          state.chainId === 6343 &&
          state.signer?.toLowerCase() === profile.controller.toLowerCase() &&
          /^0x[0-9a-f]{64}$/i.test(state.profileHash),
        "controller_inventory_profile_changed",
      );
      insist(
        state.transactions &&
          typeof state.transactions === "object" &&
          !Array.isArray(state.transactions),
        "controller_inventory_missing_transactions",
      );
      rows = Object.values(state.transactions);
    } else {
      insist(
        state.controller?.toLowerCase() === profile.controller.toLowerCase() &&
          state.communityId === profile.communityId &&
          state.intents &&
          typeof state.intents === "object" &&
          !Array.isArray(state.intents),
        "controller_custom_inventory_changed",
      );
      rows = Object.values(state.intents);
    }
  }
  insist(
    rows.length > 0 &&
      rows.length <= 10000 &&
      rows.every(
        (row) =>
          Number.isSafeInteger(row.nonce) &&
          row.nonce >= 0 &&
          /^0x[0-9a-f]+$/i.test(row.raw) &&
          /^0x[0-9a-f]{64}$/i.test(row.hash),
      ),
    "controller_unresolved_allocation",
  );
  insist(
    sha256File(entry.path) === entry.sha256,
    "controller_inventory_changed_during_read",
  );
  return rows;
}
export async function readControllerInventory(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  head: bigint,
) {
  readCustody(profile);
  const observed = new Map<number, Hex>();
  for (const entry of profile.inventory) {
    for (const row of allocations(profile, entry)) {
      insist(
        keccak256(row.raw) === row.hash,
        "controller_inventory_hash_changed",
      );
      const tx = parseTransaction(row.raw);
      insist(
        tx.chainId === 6343 &&
          tx.nonce === row.nonce &&
          (
            await recoverTransactionAddress({
              serializedTransaction: row.raw as TransactionSerialized,
            })
          ).toLowerCase() === profile.controller.toLowerCase(),
        "controller_inventory_signer_changed",
      );
      insist(
        !observed.has(row.nonce) || observed.get(row.nonce) === row.hash,
        "controller_conflicting_nonce",
      );
      const receipt = await client.getTransactionReceipt({ hash: row.hash });
      insist(
        receipt.transactionHash === row.hash &&
          receipt.blockNumber + 11n <= head &&
          (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
            receipt.blockHash,
        "controller_inventory_not_canonical_settled",
      );
      // Reverts consume the nonce too; a private settled/mined label alone is
      // never accepted. Custom V2 deployment files need no invented receipt field.
      observed.set(row.nonce, row.hash);
    }
    insist(
      sha256File(entry.path) === entry.sha256,
      "controller_inventory_changed_during_audit",
    );
  }
  insist(
    [...observed.keys()].every((nonce) => nonce < profile.nonce),
    "controller_inventory_future_nonce",
  );
  return [...observed]
    .sort(([a], [b]) => a - b)
    .map(([nonce, hash]) => ({ nonce, hash }));
}
