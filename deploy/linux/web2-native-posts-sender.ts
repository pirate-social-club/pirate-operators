import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { bytesToHex, keccak256, serializeTransaction, type Address, type Hex, type TransactionSerializedLegacy } from "viem";
import { sign as signHash } from "viem/accounts";
import { bytes32, canonical, exact, object } from "../../packages/community/common.ts";
import { publicationData, type FirstPublication } from "../../packages/community/post-chain.ts";
import { requireDedicatedManagedSigner } from "../../packages/release/managed-publishing-admission.ts";
import {
  assertNativePostsDispatchProofCurrent, readNativePostsDispatchProof, readNativePostsPublicationReference,
  type NativePostsDispatchRequest, type NativePostsPublicationReference, type NativePostsPublicationStatus, type NativePostsQuote,
} from "../../services/native-posts-publication.ts";
import { publicationResponseBytes } from "../../services/publication-app-documents.ts";
import type { Store } from "../../services/operator-store.ts";
import { privateDirectory, type OperationLease } from "./backend-state.ts";
import { assertPinnedNativeDanceStoreConnectionSync } from "./web2-native-dance-store-connection.ts";
import { nativeDancePublisherHoldKey } from "../../services/native-dance-publisher-hold-key.ts";
import {
  createNativePostsJournal, postsSame, postsTransaction, type NativePostsHold, type NativePostsStoredQuote,
  type PostsCatalogWitness,
} from "./web2-native-posts-journal.ts";
import type { NativePostsChain, NativePostsTerminal, NativePostsTransaction } from "./web2-native-posts-chain.ts";

type StoreIdentity = Parameters<typeof assertPinnedNativeDanceStoreConnectionSync>[1];
type Reference = Readonly<NativePostsPublicationReference>;
type Request = { reference: Reference; signal: AbortSignal; assertHostCurrent(): true };
type DispatchRequest = Request & NativePostsDispatchRequest & {
  /** Optional absolute ceiling from the independently admitted local ingress. */
  dispatchNotAfterMs?: number;
  /** Authenticated and bounded private dispatch-ready transport. */
  revalidate(): Promise<{ status: number; contentType: string | null; raw: string }>;
};

type PostsOriginal = Readonly<{ family: "posts"; commandId: Hex; nonce: number }>;
interface InspectPermit {
  assertCurrent(): number;
  hold(): Readonly<NativePostsHold> | undefined;
}
interface PostsPermit extends InspectPermit {
  reserve<T>(writeStart: () => T): T | undefined;
  assertBeforeSign(): true;
  recordAttempt(hash: Hex, markPaired: () => void): void;
  assertBeforeSend(hash: Hex): true;
}
/** Adapter from the existing single stage nonce gate, never a second cursor. */
export interface NativePostsCommonGate {
  assertBinding(store: Store, lease: OperationLease, publisher: Address, identity: StoreIdentity): void;
  inspectPosts<T>(work: (permit: InspectPermit) => Promise<T>): Promise<T>;
  runPrivate<T>(original: PostsOriginal, work: (permit: PostsPermit) => Promise<T>): Promise<T>;
  reconcilePrivate(original: PostsOriginal, verify: (attempt: Readonly<NativePostsHold>) => Promise<true>,
    finish: () => void): Promise<void>;
}

interface QuoteSelection {
  quote: Readonly<NativePostsQuote>;
  grantSha256: Hex;
  qualification: {
    reference: { applicationOriginalSha256: Hex; releaseSelectionSha256: Hex; jobId: string; operationId: Hex; requestHash: Hex };
    publisherOriginal: Readonly<FirstPublication>;
    sender: Address;
    anchor: { blockNumber: bigint; blockHash: Hex };
    transaction: NativePostsTransaction;
    maximumFee: bigint;
    expiresAtMs: number;
  };
}

export interface NativePostsCatalogPorts {
  /** Calls the mounted producer's preSign with the exact current ready receipt. */
  preSign(signal: AbortSignal): Promise<Readonly<PostsCatalogWitness>>;
  /** Calls prepareBind against the exact retained paired bytes and witness. */
  prepareBind(signal: AbortSignal): Promise<{ posting: unknown; original: unknown; readyReceipt: unknown }>;
  /** Actual protected catalog transport for the exact persisted bundle. The
   * mount runs assertReadyToBind with live authority at its real send boundary. */
  bind(bundle: Readonly<Awaited<ReturnType<NativePostsCatalogPorts["prepareBind"]>>>,
    signal: AbortSignal): Promise<{ requestSha256: Hex; receipt: unknown; disposition: "bind_reply" | "recovered_status" }>;
  /** Calls the mounted successor assertReadyToFetch. It returns the finite
   * receipt/current-authority cutoff, which survives the attempted commit. */
  assertReadyToFetch(bundle: Readonly<Awaited<ReturnType<NativePostsCatalogPorts["prepareBind"]>>>,
    evidence: Readonly<Awaited<ReturnType<NativePostsCatalogPorts["bind"]>>>,
    signal: AbortSignal): Promise<Readonly<{ posting: unknown; expiresAtMs: number; assertAfterAttempt(): void }>>;
}
type CatalogPaired = Readonly<{ state: "retained_unsent" | "attempt_unknown"; transactionHash: Hex; raw: Hex; nonce: number }>;

function earlier(...deadlines: number[]) {
  assert(deadlines.every(value => Number.isSafeInteger(value) && value > 0), "native_posts_deadline_unavailable");
  const result = Math.min(...deadlines);
  assertNativePostsDispatchProofCurrent(result);
  return result;
}

export async function createNativePostsSender(input: {
  store: Store; lease: OperationLease; storeIdentity: StoreIdentity; journalDirectory: string;
  gate: NativePostsCommonGate; chain: NativePostsChain;
  scope: { installationId: Hex; releaseSha256: Hex; applicationOriginalSha256: Hex; grantSha256: Hex; expiresAtMs: number };
  signer: { address: Address; assertCurrent(): Promise<void>; assertCurrentSync(): true;
    withKey<T>(action: (bytes: Uint8Array) => Promise<T>): Promise<T> };
  /** Calls Rollout createSelectedPostsQuote with Lane 2's original qualifier. */
  quotePlanned(reference: Reference, signal: AbortSignal): Promise<QuoteSelection>;
  /** Builds Rollout's catalog producer for this exact original inside the
   * same permit. These closures are private and may expose retained bytes. */
  catalog(selection: Readonly<NativePostsStoredQuote>, access: {
    assertHeld(): void;
    readPairedOriginal(): Promise<CatalogPaired | null>;
    readPreSignWitness(): Promise<Readonly<PostsCatalogWitness>>;
  }): NativePostsCatalogPorts;
  /** Protected operator recovery receipt/authority for this exact original. */
  assertConfirmedRecovery(reference: Reference, evidence: Extract<NativePostsTerminal, { state: "confirmed" }>): true;
}) {
  const { store, lease, gate, chain, signer } = input;
  const scope = Object.freeze({ ...input.scope }), storeIdentity = Object.freeze({ ...input.storeIdentity });
  assert(signer.address === chain.publisher, "native_posts_publisher_changed");
  gate.assertBinding(store, lease, chain.publisher, storeIdentity);
  const directory = input.journalDirectory;
  await privateDirectory(directory);
  const directoryIdentity = lstatSync(directory, { bigint: true });
  function assertDirectoryCurrent() {
    const current = lstatSync(directory, { bigint: true });
    assert(realpathSync(directory) === directory && current.isDirectory() && current.uid === BigInt(process.getuid!()) &&
      !(current.mode & 0o077n) && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino,
      "native_posts_journal_directory_changed");
  }
  const journal = createNativePostsJournal({ store, directory, publisher: chain.publisher, target: chain.target,
    assertDirectoryCurrent });

  function scoped(request: Request) {
    const ref = readNativePostsPublicationReference(canonical(request.reference));
    assert(ref.installationId === scope.installationId && ref.releaseSha256 === scope.releaseSha256,
      "native_posts_reference_scope_changed");
    return ref;
  }
  function held(request: Request, permit: InspectPermit) {
    request.signal.throwIfAborted();
    assert(request.assertHostCurrent() === true, "native_posts_host_authority_unavailable");
    assertDirectoryCurrent();
    const deadline = permit.assertCurrent();
    request.signal.throwIfAborted();
    return earlier(deadline, scope.expiresAtMs);
  }
  function clearSlot(permit: InspectPermit) {
    assert(permit.hold() === undefined && store.get(nativeDancePublisherHoldKey) === undefined,
      "native_posts_shared_original_held");
  }
  async function clean(request: Request, ref: Reference, permit: InspectPermit) {
    clearSlot(permit);
    journal.assertNoOriginal(ref.operationId);
    const nonce = journal.cursor();
    journal.assertNoForeignNonceIndex(nonce);
    const deadline = await chain.assertCleanNonce(nonce);
    held(request, permit);
    clearSlot(permit);
    assert(journal.cursor() === nonce, "native_posts_cursor_changed");
    journal.assertNoOriginal(ref.operationId);
    journal.assertNoForeignNonceIndex(nonce);
    return { nonce, deadline };
  }
  async function observe(request: Request): Promise<NativePostsPublicationStatus> {
    const ref = scoped(request);
    return gate.inspectPosts(async permit => {
      held(request, permit);
      try {
        const paired = await journal.readPaired(ref, permit.hold);
        if (!paired) {
          const { deadline } = await clean(request, ref, permit);
          earlier(held(request, permit), deadline);
          return { state: "no_attempt" };
        }
        const { row, tx, terminal } = paired;
        if (row.broadcast === "retained-unsent") {
          held(request, permit);
          paired.assertCurrent();
          return { state: "retained_unsent", transactionHash: row.hash };
        }
        const result = await chain.safeOriginal(tx, row.start.selected.publication, row.hash,
          BigInt(row.start.selected.quote.maximumFeeWei)).catch(() => null);
        held(request, permit);
        paired.assertCurrent();
        if (terminal && !postsSame(terminal, result)) return { state: "attempt_unknown", transactionHash: row.hash };
        return result ?? { state: "attempt_unknown", transactionHash: row.hash };
      } catch {
        held(request, permit);
        return { state: "held" };
      }
    });
  }

  function verifySelectedQuote(ref: Reference, value: QuoteSelection, nonce: number): NativePostsStoredQuote {
    const { quote, qualification: q, grantSha256 } = value, tx = q.transaction;
    assert(grantSha256 === scope.grantSha256 && q.sender === chain.publisher && tx.type === "legacy" &&
      tx.chainId === 6343 && tx.to === chain.target && tx.nonce === nonce && tx.value === 0n &&
      q.publisherOriginal.communityId === chain.communityId && q.publisherOriginal.configurationRevision === 1 &&
      tx.data === publicationData(q.publisherOriginal) && quote.maximumFeeWei === q.maximumFee.toString() &&
      quote.expiresAtMs <= q.expiresAtMs && q.maximumFee > tx.gas * tx.gasPrice &&
      postsSame(q.reference, { applicationOriginalSha256: scope.applicationOriginalSha256,
        releaseSelectionSha256: ref.releaseSha256, jobId: ref.jobId, operationId: ref.operationId, requestHash: ref.requestHash }),
      "native_posts_qualification_changed");
    bytes32(quote.quoteSha256);
    bytes32(quote.initiatingLeaseSha256);
    return Object.freeze({ reference: ref, quote: Object.freeze({ ...quote }), grantSha256,
      publication: Object.freeze({ ...q.publisherOriginal }), anchorNumber: q.anchor.blockNumber.toString(),
      anchorHash: bytes32(q.anchor.blockHash), nonce, gas: tx.gas.toString(), gasPrice: tx.gasPrice.toString() });
  }

  async function quote(request: Request): Promise<Readonly<NativePostsQuote>> {
    const ref = scoped(request);
    return gate.inspectPosts(async permit => {
      const initial = await clean(request, ref, permit);
      const value = await input.quotePlanned(ref, request.signal);
      const current = await clean(request, ref, permit);
      assert(initial.nonce === current.nonce, "native_posts_cursor_changed");
      const selected = verifySelectedQuote(ref, value, current.nonce);
      earlier(held(request, permit), current.deadline, selected.quote.expiresAtMs);
      journal.retainQuote(selected);
      earlier(held(request, permit), current.deadline, selected.quote.expiresAtMs);
      return selected.quote;
    });
  }

  async function execute(request: DispatchRequest): Promise<NativePostsPublicationStatus> {
    const ref = scoped(request);
    const existing = await observe(request);
    if (existing.state !== "no_attempt") return existing;
    const selected = journal.selectedQuote(ref.operationId, request.quoteSha256);
    assert(postsSame(ref, selected.reference) && selected.grantSha256 === scope.grantSha256 &&
      selected.quote.initiatingLeaseSha256 === request.initiatingLeaseSha256, "native_posts_prepared_quote_changed");
    const tx = postsTransaction(selected, chain.target), maximumFee = BigInt(selected.quote.maximumFeeWei);
    const quoteAnchor = { blockNumber: BigInt(selected.anchorNumber), blockHash: selected.anchorHash };
    const digest = keccak256(serializeTransaction(tx));
    const original = { family: "posts", commandId: ref.operationId, nonce: tx.nonce } as const;
    return gate.runPrivate(original, async permit => {
      // The existing gate has proved the slot free while taking the permit.
      assert((await clean(request, ref, permit)).nonce === tx.nonce, "native_posts_nonce_unsettled");
      async function primary() {
        const result = await request.revalidate();
        assert(result.status === 200 && result.contentType === "application/json" &&
          Buffer.byteLength(result.raw) <= 32_768, "native_posts_primary_unavailable");
        const proof = readNativePostsDispatchProof(result.raw, { ...request, reference: ref });
        assert(proof.calldata === tx.data && proof.maximumFeeWei === selected.quote.maximumFeeWei &&
          proof.expiresAtMs <= selected.quote.expiresAtMs, "native_posts_primary_changed");
        return earlier(held(request, permit), proof.expiresAtMs);
      }
      const acceptedDeadline = earlier(await primary(), request.dispatchNotAfterMs ?? scope.expiresAtMs);
      let start: ReturnType<typeof journal.reserve> | undefined;
      const catalog = input.catalog(selected, {
        assertHeld() { held(request, permit); },
        async readPairedOriginal() {
          const pair = await journal.readPaired(ref, permit.hold);
          held(request, permit);
          if (!pair) return null;
          pair.assertCurrent();
          const { row } = pair;
          return Object.freeze({ state: row.broadcast === "attempted" ? "attempt_unknown" : "retained_unsent",
            transactionHash: row.hash, raw: row.raw, nonce: row.nonce });
        },
        async readPreSignWitness() {
          assert(start, "native_posts_sign_witness_unavailable");
          const paired = await journal.readPaired(ref, permit.hold);
          assert(paired && postsSame(paired.row.start, start), "native_posts_sign_witness_changed");
          held(request, permit);
          paired.assertCurrent();
          return Object.freeze({ ...start.witness, expiresAtMs: Math.min(start.witness.expiresAtMs, start.signExpiresAtMs) });
        },
      });
      const witness = structuredClone(await catalog.preSign(request.signal));
      const initialFeeDeadline = await chain.preflight(tx, selected.publication, maximumFee, quoteAnchor);
      await signer.assertCurrent();
      let entered = false;
      let signed: TransactionSerializedLegacy | undefined;
      const raw = await signer.withKey(async (bytes) => {
        assert(!entered, "native_posts_key_callback_reentered");
        entered = true;
        const privateKey = bytesToHex(bytes);
        const account = requireDedicatedManagedSigner(privateKey, chain.rpcUrl);
        assert(account.address.toLowerCase() === chain.publisher, "native_posts_publisher_changed");
        assert(await chain.pendingNonce() === tx.nonce, "native_posts_nonce_unsettled");
        const deadline = earlier(acceptedDeadline, initialFeeDeadline, witness.expiresAtMs, await primary());
        start = permit.reserve(() => journal.reserve(selected, witness, deadline));
        assert(start, "native_posts_signing_start_unavailable");
        journal.assertReserved(start);
        assert(permit.assertBeforeSign() === true && signer.assertCurrentSync() === true, "native_posts_key_permit_unavailable");
        earlier(held(request, permit), deadline);
        const signature = await signHash({ hash: digest, privateKey });
        signed = serializeTransaction(tx, signature);
        return signed;
      });
      assert(start && signed && raw === signed, "native_posts_key_result_changed");

      const row = await journal.retain(start, raw, () => { held(request, permit); });
      const bundle = structuredClone(await catalog.prepareBind(request.signal));
      const catalogKey = "nativePostsCatalogBind:" + ref.operationId;
      const binding = { bundle, quoteSha256: request.quoteSha256, transactionHash: row.hash };
      store.transaction(() => {
        assert(store.get(catalogKey) === undefined, "native_posts_catalog_binding_changed");
        store.set(catalogKey, binding);
      });
      const evidence = structuredClone(await catalog.bind(bundle, request.signal));
      const ready = await catalog.assertReadyToFetch(bundle, evidence, request.signal);
      assert(postsSame(ready.posting, bundle.posting), "native_posts_catalog_ack_changed");
      const catalogDeadline = earlier(ready.expiresAtMs, start.signExpiresAtMs);
      const feeDeadline = await chain.preflight(tx, selected.publication, maximumFee, quoteAnchor, raw);
      const paired = await journal.readPaired(ref, permit.hold);
      assert(paired && postsSame(paired.row, row) && await chain.pendingNonce() === tx.nonce,
        "native_posts_pair_changed");
      const submission = new Request(chain.rpcUrl, { method: "POST", redirect: "error", signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
      const sendDeadline = earlier(acceptedDeadline, start.signExpiresAtMs, catalogDeadline, feeDeadline, await primary());
      permit.recordAttempt(row.hash, () => {
        paired.assertCurrent();
        assert(postsSame(store.get(catalogKey), binding), "native_posts_catalog_binding_changed");
        earlier(held(request, permit), sendDeadline);
        store.set(catalogKey, { ...binding, evidence, expiresAtMs: catalogDeadline });
        journal.markAttempt(row);
      });
      paired.assertCurrent("attempted");
      assert(permit.assertBeforeSend(row.hash) === true, "native_posts_fetch_permit_unavailable");
      ready.assertAfterAttempt();
      const currentSendDeadline = Math.min(held(request, permit), sendDeadline);
      assertNativePostsDispatchProofCurrent(currentSendDeadline);
      const response = await fetch(submission);
      const reply = object(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(await publicationResponseBytes(response, 8192))));
      exact(reply, ["jsonrpc", "id", "result"]);
      assert(response.ok && reply.jsonrpc === "2.0" && reply.id === 1 && reply.result === row.hash,
        "native_posts_rpc_ack_changed");
      held(request, permit);
      paired.assertCurrent("attempted");
      return { state: "attempt_unknown", transactionHash: row.hash };
    });
  }

  /** Operator-scoped release after exact safe success. Revert and ambiguous
   * originals keep their hold. This method never signs or sends anything. */
  async function reconcileConfirmed(request: Request) {
    const ref = scoped(request);
    const observed = await gate.inspectPosts(async permit => {
      held(request, permit);
      const paired = await journal.readPaired(ref, permit.hold);
      assert(paired && paired.row.broadcast === "attempted" && !paired.terminal, "native_posts_recovery_unavailable");
      paired.assertCurrent();
      return { nonce: paired.row.nonce, hold: permit.hold() };
    });
    let complete: (() => void) | undefined;
    await gate.reconcilePrivate({ family: "posts", commandId: ref.operationId, nonce: observed.nonce }, async hold => {
      assert(postsSame(hold, observed.hold), "native_posts_recovery_hold_changed");
      const pair = await journal.readPaired(ref, () => hold);
      assert(pair && !pair.terminal, "native_posts_recovery_unavailable");
      const { row, tx } = pair;
      const result = await chain.safeOriginal(tx, row.start.selected.publication, row.hash,
        BigInt(row.start.selected.quote.maximumFeeWei));
      assert(result?.state === "confirmed", "native_posts_canonical_success_required");
      complete = () => {
        request.signal.throwIfAborted();
        assert(request.assertHostCurrent() === true && input.assertConfirmedRecovery(ref, result) === true,
          "native_posts_recovery_authority_unavailable");
        pair.assertCurrent();
        request.signal.throwIfAborted();
        journal.retainConfirmed(row, result);
      };
      return true;
    }, () => {
      assert(complete, "native_posts_recovery_unavailable");
      complete();
    });
  }

  return Object.freeze({ quote, execute, observe, reconcileConfirmed });
}
