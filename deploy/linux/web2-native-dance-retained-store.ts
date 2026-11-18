import assert from "node:assert/strict";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { getSerializedTransactionType, parseTransaction, recoverTransactionAddress, type TransactionSerializedLegacy } from "viem";
import { canonical } from "../../packages/protocol/index.ts";
import { consentAddress, consentDigest } from "../../packages/protocol/publication-consent.ts";
import type { Store } from "../../services/operator-store.ts";
import { exact, record } from "../../services/publication-command-contract.ts";
import {
  assertNativeDanceScope, nativeDanceAttempt, type NativeDanceRetainedReference, type NativeDanceRetainedScope,
} from "../../services/native-dance-retained-reference.ts";
import { privateDirectory, privateFile, type OperationLease } from "./backend-state.ts";
import { assertPinnedNativeDanceStoreConnection } from "./web2-native-dance-store-connection.ts";

const commandIndex = "local6343PublisherOriginal:";
const nonceIndex = "local6343PublisherNonce:";
const nonceKey = (nonce: number) => nonceIndex + String(nonce).padStart(10, "0");
type ReadStore = Pick<Store, "get" | "page" | "sql">;
const retainedStores = new WeakMap<object, NativeDancePublisherIdentity>();
const markerKey = "publicationOperatorIdentity:v1";
export interface NativeDancePublisherIdentity {
  readonly storeIdentity: Readonly<{ path: string; device: string; inode: string; journalId: `0x${string}` }>;
  readonly journalDirectory: string;
  readonly directoryIdentity: Readonly<{ device: string; inode: string }>;
  readonly runId: string;
  readonly genesisHash: `0x${string}`;
}
type Inputs = NativeDancePublisherIdentity & {
  /** Already-open exact Store from the installed publisher owner. */
  store: ReadStore;
  scope: NativeDanceRetainedScope;
  /** Verifies retained private Store identity, launch and original-directory
   * custody, including when the sender's callback has already closed. */
  assertCustody(): Promise<void>;
};

function legacy(raw: `0x${string}`): asserts raw is TransactionSerializedLegacy {
  assert(getSerializedTransactionType(raw) === "legacy", "native_dance_original_changed");
}

/** A read-only view of the existing command/nonce and composer journals. */
export async function createNativeDanceRetainedStore(input: Inputs) {
  const { store, journalDirectory, runId, genesisHash } = input;
  const directory = structuredClone(input.directoryIdentity), scope = structuredClone(input.scope),
    selectedStore = structuredClone(input.storeIdentity);
  const marker = { schema: "pirate.local-publication-operator-journal/1",
    journalId: consentDigest(selectedStore.journalId), chainId: scope.chainId, genesisHash: consentDigest(genesisHash),
    communityId: scope.communityId, installationId: scope.installationId, publisher: scope.publisher };
  const assertCustody = input.assertCustody.bind(input);
  async function current(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await assertCustody();
    await privateDirectory(journalDirectory);
    const st = await lstat(journalDirectory, { bigint: true });
    assert(st.isDirectory() && String(st.dev) === directory.device && String(st.ino) === directory.inode,
      "native_dance_original_directory_changed");
    const witness = await privateFile(selectedStore.path, Number.MAX_SAFE_INTEGER);
    try {
      const st = await witness.stat({ bigint: true });
      assert(String(st.dev) === selectedStore.device && String(st.ino) === selectedStore.inode,
        "native_dance_store_changed");
      const files = store.sql.exec<{ name: string; file: string }>("PRAGMA database_list").toArray();
      assert(files.filter(file => file.name === "main" && file.file === selectedStore.path).length === 1 &&
        canonical(store.get(markerKey) ?? null) === canonical(marker), "native_dance_store_changed");
    } finally { await witness.close(); }
    signal?.throwIfAborted();
  }
  await current();
  async function readFile(step: string) {
    const path = join(journalDirectory, step + ".original.json");
    const existing = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!existing) return null;
    const file = await privateFile(path, 32 * 1024);
    try {
      const before = await file.stat({ bigint: true });
      assert(before.dev === existing.dev && before.ino === existing.ino, "native_dance_original_changed");
      assert(before.size > 0n && before.size <= 32n * 1024n, "native_dance_original_changed");
      const bytes = Buffer.alloc(Number(before.size));
      const read = await file.read(bytes, 0, bytes.length, 0);
      const after = await lstat(path, { bigint: true });
      assert(read.bytesRead === bytes.length && before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
        "native_dance_original_changed");
      return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } finally {
      await file.close();
    }
  }
  async function assertNoPreparedFile(step: string, signal: AbortSignal) {
    const listing = await opendir(journalDirectory);
    let count = 0;
    for await (const entry of listing) {
      signal.throwIfAborted();
      assert(++count <= 256, "native_dance_absence_unavailable");
      assert(!entry.name.startsWith(step + ".original.json."), "native_dance_journals_disagree");
    }
  }
  function absence(commandId: string) {
    // Catch a surviving orphaned reverse index. A busy history beyond one
    // bounded request is unavailable until its owner proves the absence.
    let cursor = nonceIndex;
    for (let page = 0; page < 4; page++) {
      const rows = store.page(nonceIndex, cursor, 64);
      assert(rows.every(({ value }) => {
        const item = record(value);
        return typeof item.commandId === "string" && item.commandId !== commandId;
      }), "native_dance_journals_disagree");
      if (rows.length < 64) return;
      cursor = rows.at(-1)!.key;
    }
    throw Error("native_dance_absence_unavailable");
  }
  const retained = Object.freeze({
    async assertScope(selectedStore: object, expected: Readonly<NativeDanceRetainedScope>) {
      assert(selectedStore === store && canonical(scope) === canonical(expected), "native_dance_store_scope_changed");
      await current();
    },
    assertOwner(selectedStore: object, ref: NativeDanceRetainedReference) {
      assert(selectedStore === store, "native_dance_store_changed");
      assertNativeDanceScope(ref, scope);
    },
    async read(selectedStore: object, ref: NativeDanceRetainedReference, calldata: string, signal: AbortSignal) {
      assert(selectedStore === store, "native_dance_store_changed");
      assertNativeDanceScope(ref, scope);
      const { original } = ref;
      const key = commandIndex + original.commandId, step = "10-original-" + original.commandId.slice(2);
      await current(signal);
      const entry = await readFile(step), row = store.get<unknown>(key);
      await current(signal);
      if (entry === null && row === undefined) {
        absence(original.commandId);
        await assertNoPreparedFile(step, signal);
        assert(await readFile(step) === null, "native_dance_journals_disagree");
        await current(signal);
        assert(store.get(key) === undefined, "native_dance_journals_disagree");
        absence(original.commandId);
        return null;
      }
      assert(entry && row !== undefined, "native_dance_journals_disagree");
      const saved = record(row);
      exact(saved, ["commandId", "commandHash", "target", "data", "raw", "hash", "nonce", "broadcast"]);
      exact(entry, ["runId", "step", "chainId", "genesisHash", "sender", "nonce", "gas", "gasPrice", "to", "data", "transactionHash", "raw", "value", "commandHash"]);
      const attempt = nativeDanceAttempt({ nonce: saved.nonce, hash: saved.hash, raw: saved.raw });
      assert(attempt && saved.commandId === original.commandId && saved.commandHash === original.commandHash &&
        saved.target === original.verifier && saved.data === calldata &&
        (saved.broadcast === "retained-unsent" || saved.broadcast === "attempted") &&
        entry.runId === runId && entry.step === step && entry.genesisHash === genesisHash && entry.value === "0" &&
        entry.chainId === scope.chainId && entry.sender === original.publisher && entry.to === original.verifier &&
        entry.commandHash === original.commandHash && entry.data === calldata && entry.nonce === attempt.nonce &&
        entry.transactionHash === attempt.hash && entry.raw === attempt.raw,
        "native_dance_journals_disagree");
      legacy(attempt.raw);
      const tx = parseTransaction(attempt.raw);
      assert(tx.chainId === scope.chainId && tx.nonce === attempt.nonce && tx.to?.toLowerCase() === original.verifier &&
        tx.data === calldata && (tx.value ?? 0n) === 0n && String(tx.gas) === entry.gas && String(tx.gasPrice) === entry.gasPrice &&
        consentAddress((await recoverTransactionAddress({ serializedTransaction: attempt.raw })).toLowerCase()) === original.publisher,
        "native_dance_original_changed");
      const again = await readFile(step);
      await current(signal);
      assert(again && canonical(again) === canonical(entry) &&
        canonical(store.get(key) ?? null) === canonical(saved) &&
        canonical(store.get(nonceKey(attempt.nonce)) ?? null) === canonical(saved), "native_dance_journals_disagree");
      return Object.freeze(attempt);
    },
  });
  retainedStores.set(retained, {
    storeIdentity: selectedStore, journalDirectory, directoryIdentity: directory, runId, genesisHash,
  });
  return retained;
}
export type NativeDanceRetainedStore = Awaited<ReturnType<typeof createNativeDanceRetainedStore>>;


export async function assertNativeDanceRetainedCustody(
  retained: NativeDanceRetainedStore, operatorStore: object, expected: Readonly<NativeDanceRetainedScope>,
) {
  assert(retainedStores.has(retained), "native_dance_custody_unavailable");
  await retained.assertScope(operatorStore, expected);
}

/** Both public Stage and scoped reopen consume the same independently
 * verified retained owner admission. Compare its physical pin before a
 * locally valid reader and Store can be used for the scoped action. */
export async function assertPinnedNativeDanceRetainedCustody(
  retained: NativeDanceRetainedStore, operatorStore: object, expected: Readonly<NativeDanceRetainedScope>,
  approvedPublisher: NativeDancePublisherIdentity, lease: OperationLease,
) {
  const held = retainedStores.get(retained);
  assert(held, "native_dance_custody_unavailable");
  assert(canonical(held) === canonical(approvedPublisher), "native_dance_publisher_identity_changed");
  await assertPinnedNativeDanceStoreConnection(operatorStore, approvedPublisher.storeIdentity, lease);
  await retained.assertScope(operatorStore, expected);
  await assertPinnedNativeDanceStoreConnection(operatorStore, approvedPublisher.storeIdentity, lease);
}
