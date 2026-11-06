// This registry fences participating commands only. It does not discover or
// lock legacy runners. Their reviewed finite inventory/custody stays required.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { insist } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import { privateExistingFile } from "./controller-inventory.ts";
import {
  correctionIntent,
  type StudyCorrectionProfile,
} from "./study-correction-plan.ts";
import type { CorrectionTransaction } from "./study-correction-runner.ts";

interface CatalogEntry {
  profileHash: Hex;
  nonce: number;
  journalPath: string;
  stage: "registered" | "prepared";
}
export function readCorrectionTransaction(path: string) {
  privateExistingFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM records WHERE key='correction'")
      .get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as CorrectionTransaction) : undefined;
  } finally {
    db.close();
  }
}
async function inspectControllerProfiles(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  known: CatalogEntry[],
  journalPath: string,
) {
  const intent = correctionIntent(profile);
  insist(
    Array.isArray(known) &&
      known.length <= 128 &&
      new Set(known.map((entry) => entry.profileHash)).size === known.length,
    "controller_catalog_invalid",
  );
  const directory = dirname(journalPath);
  // Only this command's fixed namespace is inspected. This does not discover
  // legacy journals or confer custody over other processes, disks or services.
  // A lost catalog/row cannot erase an orphaned prepared journal or lock.
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const match = /^([0-9a-f]{64})\.sqlite(.*)$/i.exec(name);
    if (!match) continue;
    const profileHash = `0x${match[1]}`.toLowerCase();
    insist(
      known.some((entry) => entry.profileHash === profileHash),
      "controller_namespace_orphan",
    );
    insist(
      match[2] === "" || match[2] === ".lock",
      "controller_namespace_sidecar_or_unrecognized_artifact",
    );
    privateExistingFile(join(directory, name));
  }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const anchor = await client.getBlock({ blockNumber: head });
  insist(
    (await client.getChainId()) === 6343,
    "controller_catalog_wrong_chain",
  );
  for (const entry of known) {
    insist(
      /^0x[0-9a-f]{64}$/.test(entry.profileHash) &&
        Number.isSafeInteger(entry.nonce) &&
        entry.nonce >= 0 &&
        ["registered", "prepared"].includes(entry.stage) &&
        entry.journalPath ===
          join(dirname(journalPath), entry.profileHash.slice(2) + ".sqlite"),
      "controller_catalog_entry_changed",
    );
    if (entry.profileHash === intent.profileHash) {
      insist(
        entry.journalPath === journalPath && entry.nonce === profile.nonce,
        "controller_catalog_profile_changed",
      );
      if (entry.stage === "prepared") {
        const stored = readCorrectionTransaction(entry.journalPath);
        insist(
          stored?.profileHash === entry.profileHash &&
            stored.nonce === entry.nonce,
          "controller_prepared_journal_missing",
        );
      }
      continue;
    }
    const stored = readCorrectionTransaction(entry.journalPath);
    insist(
      stored?.profileHash === entry.profileHash &&
        stored.nonce === entry.nonce &&
        stored.raw &&
        stored.hash &&
        keccak256(stored.raw) === stored.hash,
      "controller_prior_profile_unresolved",
    );
    const tx = parseTransaction(stored.raw);
    insist(
      tx.chainId === 6343 &&
        tx.nonce === entry.nonce &&
        (
          await recoverTransactionAddress({
            serializedTransaction: stored.raw as TransactionSerialized,
          })
        ).toLowerCase() === profile.controller.toLowerCase(),
      "controller_catalog_signer_changed",
    );
    const receipt = await client.getTransactionReceipt({ hash: stored.hash });
    insist(
      receipt.transactionHash === stored.hash &&
        receipt.blockNumber + 11n <= head &&
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
          receipt.blockHash,
      "controller_prior_profile_unresolved",
    );
  }
  insist(
    (await client.getBlock({ blockNumber: head })).hash === anchor.hash,
    "controller_catalog_head_changed",
  );
  return intent;
}
export async function auditControllerCatalog(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  journalPath: string,
) {
  const catalogPath = join(dirname(journalPath), "dispatch-custody.sqlite");
  let known: CatalogEntry[] = [];
  if (existsSync(catalogPath)) {
    privateExistingFile(catalogPath);
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM records WHERE key='controller:profiles'")
        .get() as { value: string } | undefined;
      known = row ? JSON.parse(row.value) : [];
    } finally {
      db.close();
    }
  }
  await inspectControllerProfiles(client, profile, known, journalPath);
  return { registeredProfiles: known.length };
}
export async function registerControllerProfile(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  lease: TxStore,
  journalPath: string,
) {
  const known = lease.get<CatalogEntry[]>("controller:profiles") ?? [];
  const intent = await inspectControllerProfiles(
    client,
    profile,
    known,
    journalPath,
  );
  if (!known.some((entry) => entry.profileHash === intent.profileHash)) {
    insist(known.length < 128, "controller_catalog_limit");
    lease.transaction(() => {
      lease.set("controller:profiles", [
        ...known,
        {
          profileHash: intent.profileHash,
          nonce: profile.nonce,
          journalPath,
          stage: "registered",
        },
      ]);
    });
  }
  return {
    registered:
      known.length +
      Number(!known.some((entry) => entry.profileHash === intent.profileHash)),
  };
}
export function markControllerPrepared(
  lease: TxStore,
  journalPath: string,
  stored: CorrectionTransaction,
) {
  const known = lease.get<CatalogEntry[]>("controller:profiles") ?? [];
  const entry = known.find((entry) => entry.profileHash === stored.profileHash);
  const saved = readCorrectionTransaction(journalPath);
  insist(
    entry &&
      entry.journalPath === journalPath &&
      entry.nonce === stored.nonce &&
      saved?.profileHash === stored.profileHash &&
      saved.nonce === stored.nonce &&
      saved.gasPriceWei === stored.gasPriceWei &&
      saved.maximumFeeWei === stored.maximumFeeWei,
    "controller_registration_not_durable",
  );
  // Both databases use synchronous FULL. A durable unsigned intent exists first;
  // the registry marker commits next, strictly before any key read or signing.
  // A crash at registered may create an empty journal on same-profile recovery.
  // A prepared marker refuses a missing/empty journal, even for the same profile.
  lease.transaction(() => {
    lease.set(
      "controller:profiles",
      known.map((item) =>
        item === entry ? { ...item, stage: "prepared" } : item,
      ),
    );
  });
}
