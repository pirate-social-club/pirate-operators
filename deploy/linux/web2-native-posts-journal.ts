import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionSerializedLegacy,
} from "viem";
import { bytes32, canonical } from "../../packages/community/common.ts";
import { decimal } from "../../packages/community/manifest-core.ts";
import { publicationData, type FirstPublication } from "../../packages/community/post-chain.ts";
import type { NativePostsPublicationReference, NativePostsQuote } from "../../services/native-posts-publication.ts";
import type { Store } from "../../services/operator-store.ts";
import { hash as sha256, syncDirectory } from "./backend-state.ts";
import { readDanceActivationArtifact, retainDanceActivationArtifact } from "./web2-dance-retained-artifacts.ts";
import { pinNativeDanceEffectFile } from "./web2-native-dance-effect-authority.ts";
import type { NativePostsTerminal, NativePostsTransaction } from "./web2-native-posts-chain.ts";

export const postsCursorKey = "op:nonce";
const commandPrefix = "local6343PublisherOriginal:";
const noncePrefix = "local6343PublisherNonce:";
const startPrefix = "nativePostsSigning:";
const quotePrefix = "nativePostsQuote:";
const limit = 32_768;
const suffix = (nonce: number) => String(nonce).padStart(10, "0");
const nonceIndex = (nonce: number) => noncePrefix + suffix(nonce);
const commandIndex = (id: Hex) => commandPrefix + id;
const startKey = (id: Hex) => startPrefix + id;
const terminalKey = (id: Hex) => "nativePostsTerminal:" + id;
export const postsSame = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

export interface NativePostsStoredQuote {
  reference: Readonly<NativePostsPublicationReference>;
  quote: Readonly<NativePostsQuote>;
  grantSha256: Hex;
  publication: Readonly<FirstPublication>;
  anchorNumber: string;
  anchorHash: Hex;
  nonce: number;
  gas: string;
  gasPrice: string;
}

export interface PostsCatalogWitness {
  requestSha256: Hex;
  receipt: Readonly<{ payload: unknown; signature: Hex }>;
  expiresAtMs: number;
}

interface SigningStart {
  schema: "pirate.native-posts-signing/1";
  selected: Readonly<NativePostsStoredQuote>;
  witness: Readonly<PostsCatalogWitness>;
  signExpiresAtMs: number;
}

interface Pair {
  schema: "pirate.native-posts-original/1";
  commandId: Hex;
  start: Readonly<SigningStart>;
  hash: Hex;
  nonce: number;
  raw: TransactionSerializedLegacy;
  broadcast: "retained-unsent" | "attempted";
}

export interface NativePostsHold {
  family: "posts" | "v5" | "bind";
  commandId: Hex;
  nonce: number;
  phase: "reserved" | "attempted";
  transactionHash?: Hex;
}

export function checkedPostsNonce(value: unknown) {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 32 - 1,
    "native_posts_nonce_unavailable");
  return value;
}

export function postsTransaction(selected: NativePostsStoredQuote, target: Address): NativePostsTransaction {
  return Object.freeze({
    type: "legacy", chainId: 6343, nonce: checkedPostsNonce(selected.nonce), to: target,
    data: publicationData(selected.publication), value: 0n,
    gas: BigInt(decimal(selected.gas)), gasPrice: BigInt(decimal(selected.gasPrice)),
  });
}

export async function verifyPostsRaw(raw: TransactionSerializedLegacy, tx: NativePostsTransaction, publisher: Address) {
  const parsed = parseTransaction(raw);
  assert(parsed.type === "legacy" && parsed.chainId === tx.chainId && parsed.nonce === tx.nonce &&
    parsed.to?.toLowerCase() === tx.to && (parsed.value ?? 0n) === tx.value && parsed.data === tx.data &&
    parsed.gas === tx.gas && parsed.gasPrice === tx.gasPrice &&
    (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() === publisher,
    "native_posts_signed_original_changed");
  return keccak256(raw);
}

export function createNativePostsJournal(input: {
  store: Store; directory: string; publisher: Address; target: Address;
  assertDirectoryCurrent(): void;
}) {
  const { store, directory, publisher, target } = input;
  const pathFor = (id: Hex) => join(directory, "posts-original-" + bytes32(id).slice(2) + ".json");
  const quoteKey = (id: Hex, quote: Hex) => quotePrefix + id + ":" + quote;
  const cursor = () => checkedPostsNonce(store.get(postsCursorKey));
  const assertFileAbsent = (id: Hex) => assert(!lstatSync(pathFor(id), { throwIfNoEntry: false }),
    "native_posts_file_disagrees");

  function assertNoForeignNonceIndex(nonce: number) {
    assert(store.get(nonceIndex(nonce)) === undefined &&
      store.get("tx:" + suffix(nonce)) === undefined &&
      store.get("local6343BindingSigningNonce:" + suffix(nonce)) === undefined, "native_posts_nonce_unsettled");
  }

  function assertNoOriginal(id: Hex) {
    assertFileAbsent(id);
    assert(store.get(commandIndex(id)) === undefined && store.get(startKey(id)) === undefined &&
      store.get(terminalKey(id)) === undefined, "native_posts_journal_disagrees");
    let after = noncePrefix;
    for (let scanned = 0; scanned < 4; scanned++) {
      const page = store.page(noncePrefix, after, 64);
      assert(page.every(({ value }) => typeof (value as Pair | null)?.commandId === "string" &&
        (value as Pair).commandId !== id), "native_posts_nonce_index_disagrees");
      if (page.length < 64) return;
      after = page.at(-1)!.key;
    }
    throw Error("native_posts_absence_unavailable");
  }

  function checkPair(row: Pair, hold: NativePostsHold | undefined, terminal: NativePostsTerminal | undefined) {
    const id = row.commandId;
    assert(postsSame(store.get(commandIndex(id)), row) && postsSame(store.get(nonceIndex(row.nonce)), row) &&
      postsSame(store.get(startKey(id)), row.start) && postsSame(store.get(terminalKey(id)), terminal),
      "native_posts_pair_changed");
    if (terminal) {
      assert(row.broadcast === "attempted" && terminal.state === "confirmed" &&
        terminal.transactionHash === row.hash && cursor() > row.nonce &&
        (!hold || hold.commandId !== id), "native_posts_terminal_journal_changed");
    } else {
      assert(hold?.family === "posts" && hold.commandId === id && hold.nonce === row.nonce &&
        cursor() === row.nonce + 1 &&
        (row.broadcast === "attempted"
          ? hold.phase === "attempted" && hold.transactionHash === row.hash
          : hold.phase === "reserved" && hold.transactionHash === undefined),
        "native_posts_common_hold_changed");
    }
  }

  function fileBytes(row: Pair) {
    return canonical({ schema: row.schema, commandId: row.commandId, start: row.start,
      nonce: row.nonce, transactionHash: row.hash, raw: row.raw });
  }

  return Object.freeze({
    cursor,
    assertNoOriginal,
    assertNoForeignNonceIndex,
    retainQuote(selected: Readonly<NativePostsStoredQuote>) {
      const key = quoteKey(selected.reference.operationId, selected.quote.quoteSha256);
      store.transaction(() => {
        const old = store.get(key);
        assert(old === undefined || postsSame(old, selected), "native_posts_quote_changed");
        if (old === undefined) store.set(key, selected);
      });
    },
    selectedQuote(id: Hex, quote: Hex) {
      const selected = store.get<NativePostsStoredQuote>(quoteKey(id, quote));
      assert(selected?.reference.operationId === id && selected.quote.quoteSha256 === quote,
        "native_posts_quote_unavailable");
      return selected;
    },
    reserve(selected: Readonly<NativePostsStoredQuote>, witness: Readonly<PostsCatalogWitness>, signExpiresAtMs: number) {
      const id = selected.reference.operationId;
      assertNoOriginal(id);
      assertNoForeignNonceIndex(selected.nonce);
      assert(cursor() === selected.nonce, "native_posts_nonce_unsettled");
      const start: SigningStart = { schema: "pirate.native-posts-signing/1", selected, witness, signExpiresAtMs };
      store.set(startKey(id), start);
      store.set(postsCursorKey, selected.nonce + 1);
      return Object.freeze(start);
    },
    assertReserved(start: SigningStart) {
      const id = start.selected.reference.operationId, nonce = start.selected.nonce;
      assertFileAbsent(id);
      assert(postsSame(store.get(startKey(id)), start) && store.get(commandIndex(id)) === undefined &&
        cursor() === nonce + 1, "native_posts_signing_start_changed");
      assertNoForeignNonceIndex(nonce);
    },
    async retain(start: Readonly<SigningStart>, raw: TransactionSerializedLegacy, assertCurrent: () => void) {
      const { selected } = start, id = selected.reference.operationId, path = pathFor(id);
      const tx = postsTransaction(selected, target);
      const hash = await verifyPostsRaw(raw, tx, publisher);
      assertCurrent();
      const row: Pair = { schema: "pirate.native-posts-original/1", commandId: id, start, nonce: tx.nonce,
        raw, hash, broadcast: "retained-unsent" };
      const bytes = fileBytes(row);
      await retainDanceActivationArtifact(path, bytes, limit);
      await syncDirectory(directory);
      const pin = pinNativeDanceEffectFile(path, limit, sha256(bytes));
      assertCurrent();
      store.transaction(() => {
        pin();
        assert(postsSame(store.get(startKey(id)), start) && store.get(commandIndex(id)) === undefined &&
          cursor() === tx.nonce + 1, "native_posts_signing_start_changed");
        assertNoForeignNonceIndex(tx.nonce);
        store.set(commandIndex(id), row);
        store.set(nonceIndex(tx.nonce), row);
      });
      return Object.freeze(row);
    },
    async readPaired(reference: Readonly<NativePostsPublicationReference>, hold: () => NativePostsHold | undefined) {
      input.assertDirectoryCurrent();
      const id = reference.operationId, path = pathFor(id), existing = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      const row = store.get<Pair>(commandIndex(id));
      if (!existing && row === undefined) {
        assertNoOriginal(id);
        return null;
      }
      assert(existing && row?.schema === "pirate.native-posts-original/1" && row.commandId === id &&
        row.start.schema === "pirate.native-posts-signing/1" && postsSame(row.start.selected.reference, reference) &&
        row.nonce === row.start.selected.nonce && (row.broadcast === "retained-unsent" || row.broadcast === "attempted"),
        "native_posts_journal_disagrees");
      const terminal = store.get<NativePostsTerminal>(terminalKey(id));
      checkPair(row, hold(), terminal);
      const bytes = await readDanceActivationArtifact(path, limit, existing);
      assert(bytes === fileBytes(row), "native_posts_file_disagrees");
      const pin = pinNativeDanceEffectFile(path, limit, sha256(bytes));
      const pinned = lstatSync(path, { bigint: true });
      assert(pinned.dev === existing.dev && pinned.ino === existing.ino && pinned.mtimeNs === existing.mtimeNs &&
        pinned.ctimeNs === existing.ctimeNs, "native_posts_file_disagrees");
      const tx = postsTransaction(row.start.selected, target);
      assert(await verifyPostsRaw(row.raw, tx, publisher) === row.hash, "native_posts_signed_original_changed");
      const assertCurrent = (broadcast = row.broadcast) => {
        input.assertDirectoryCurrent();
        pin();
        checkPair({ ...row, broadcast }, hold(), terminal);
      };
      assertCurrent();
      return { row, tx, terminal, assertCurrent } as const;
    },
    markAttempt(row: Pair) {
      assert(row.broadcast === "retained-unsent" && postsSame(store.get(commandIndex(row.commandId)), row) &&
        postsSame(store.get(nonceIndex(row.nonce)), row), "native_posts_pair_changed");
      const attempted = { ...row, broadcast: "attempted" } as const;
      store.set(commandIndex(row.commandId), attempted);
      store.set(nonceIndex(row.nonce), attempted);
    },
    retainConfirmed(row: Pair, result: Extract<NativePostsTerminal, { state: "confirmed" }>) {
      assert(result.transactionHash === row.hash && row.broadcast === "attempted" &&
        store.get(terminalKey(row.commandId)) === undefined, "native_posts_terminal_journal_changed");
      store.set(terminalKey(row.commandId), result);
    },
  });
}

export type NativePostsJournal = ReturnType<typeof createNativePostsJournal>;
