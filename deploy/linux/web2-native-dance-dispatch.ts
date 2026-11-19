import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  bytesToHex, decodeAbiParameters, decodeFunctionData, keccak256, parseAbi,
  parseTransaction, recoverTransactionAddress, serializeTransaction, zeroHash,
  type Address, type Hex, type PublicClient, type TransactionSerializableLegacy,
  type TransactionSerializedLegacy,
} from "viem";
import { sign as signHash } from "viem/accounts";
import { danceReadPort } from "../../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../../packages/dance-chain/v2/abi.ts";
import { danceCommand, danceSourceHash, type DanceSourcePin } from "../../packages/dance-chain/v2/wire.ts";
import { dancePayloads } from "../../packages/dance-chain/v2/wire-shapes.ts";
import { canonical } from "../../packages/protocol/index.ts";
import { requireDedicatedManagedSigner } from "../../packages/release/managed-publishing-admission.ts";
import { publicationResponseBytes } from "../../services/publication-app-documents.ts";
import { capturedFee, type CapturedPublicationFeeV1 } from "../../services/publication-command-contract.ts";
import { observeDanceV2Original } from "../../services/dance-v2-action-recovery.ts";
import {
  assertNativeDanceScope, nativeDanceAttempt, nativeDancePublisherHoldKey, nativeDanceRaw, nativeDanceReference,
  type NativeDanceRetainedReference, type NativeDanceSigned,
} from "../../services/native-dance-retained-reference.ts";
import {
  assertNativeDanceDispatchProofCurrent, type readNativeDanceDispatchProof,
} from "../../services/native-dance-dispatch-proof.ts";
import type { Store } from "../../services/operator-store.ts";
import { hash as sha256, syncDirectory, type OperationLease } from "./backend-state.ts";
import { pinNativeDanceEffectFile } from "./web2-native-dance-effect-authority.ts";
import { assertPinnedNativeDanceStoreConnectionSync } from "./web2-native-dance-store-connection.ts";
import { retainDanceActivationArtifact } from "./web2-dance-retained-artifacts.ts";
import {
  assertPublicDancePublisher, type Web2PublicDanceCustody,
} from "./web2-public-dance-custody.ts";
import type { NativeDanceRetainedStore } from "./web2-native-dance-retained-store.ts";

const commandKey = (id: Hex) => "local6343PublisherOriginal:" + id;
const nonceSuffix = (nonce: number) => String(nonce).padStart(10, "0");
const nonceKey = (nonce: number) => "local6343PublisherNonce:" + nonceSuffix(nonce);
const chainId = 6343;
const oracle = "0x420000000000000000000000000000000000000F";
const oracleAbi = parseAbi([
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);

interface SigningStart {
  reference: NativeDanceRetainedReference;
  calldata: Hex;
  nonce: number;
}
type NativeDanceDispatchProof = Readonly<ReturnType<typeof readNativeDanceDispatchProof>>;
export interface NativeDanceDispatchRequest {
  reference: NativeDanceRetainedReference;
  calldata: Hex;
  /** Private, same-request, primary-D1 effect revalidation. */
  revalidate(): Promise<NativeDanceDispatchProof>;
  /** Actual private host, route selection and transport capability pins. */
  assertHostCurrent(): true;
  signal: AbortSignal;
}
interface DispatchInputs {
  store: Store;
  lease: OperationLease;
  retained: NativeDanceRetainedStore;
  custody: Readonly<Web2PublicDanceCustody>;
  pin: DanceSourcePin;
  fee: CapturedPublicationFeeV1;
  client: PublicClient;
  rpcUrl: string;
  maxSafeBlockAgeSeconds: bigint;
  assertCurrent(): Promise<void>;
  /** The owning backend checks live private control, admission and publisher
   * custody locally. Returning a promise or void does not arm this sender. */
  assertIssueCurrent(): true;
  signer: {
    address: Address;
    assertCurrent(): Promise<void>;
    withKey<T>(action: (bytes: Uint8Array) => Promise<T>): Promise<T>;
  };
}

function checkedCommand(ref: NativeDanceRetainedReference, calldata: Hex) {
  const r = ref.original;
  const domain = { chainId: BigInt(r.chainId), verifier: r.verifier, communityId: r.communityId };
  const decoded = decodeFunctionData({ abi: danceVerdictsAbi, data: calldata });
  if (r.kind === "register") {
    assert(decoded.functionName === "registerSubmission", "native_dance_dispatch_kind_changed");
    const [payload] = decodeAbiParameters([dancePayloads.registerSubmission], decoded.args[2]);
    const command = danceCommand(domain, decoded.functionName, r.publisher, r.commandId, payload);
    assert(payload.submission.submissionId === r.resourceId &&
      command.data === calldata && command.hash === r.commandHash, "native_dance_dispatch_command_changed");
    return command;
  }
  assert(decoded.functionName === "commitVerdict", "native_dance_dispatch_kind_changed");
  const [payload] = decodeAbiParameters([dancePayloads.commitVerdict], decoded.args[2]);
  const command = danceCommand(domain, decoded.functionName, r.publisher, r.commandId, payload);
  assert(payload.decision.submissionId === r.resourceId &&
    command.data === calldata && command.hash === r.commandHash, "native_dance_dispatch_command_changed");
  return command;
}

/** Opens an effect port for an already admitted publisher. It neither acquires
 * publisher custody nor creates or adopts a different Store. All operations
 * use the held original lease and one durable sender cursor. */
export async function createNativeDanceDispatch(input: DispatchInputs) {
  const { store, lease, retained, client, signer, maxSafeBlockAgeSeconds } = input;
  const custody = structuredClone(input.custody), scope = custody.scope;
  const pin = structuredClone(input.pin);
  const fee = capturedFee(structuredClone(input.fee));
  const assertOuterCurrent = input.assertCurrent.bind(input);
  assert(typeof input.assertIssueCurrent === "function", "native_dance_dispatch_owner_fence_unavailable");
  const assertOwnerIssueCurrent = input.assertIssueCurrent.bind(input);
  const assertSignerCurrent = signer.assertCurrent.bind(signer);
  const withKey = signer.withKey.bind(signer);
  const rpcUrl = new URL(input.rpcUrl);
  assert(!rpcUrl.username && !rpcUrl.password && !rpcUrl.search && !rpcUrl.hash &&
    (rpcUrl.protocol === "https:" || rpcUrl.protocol === "http:" && rpcUrl.hostname === "127.0.0.1" && !!rpcUrl.port) &&
    client.transport.type === "http" && client.transport.url === rpcUrl.href,
    "native_dance_dispatch_rpc_changed");
  const { publisher, verifier } = scope;
  assert(scope.chainId === chainId && fee.chainId === chainId && fee.payer === publisher &&
    signer.address === publisher &&
    danceSourceHash({ chainId: BigInt(chainId), verifier, communityId: scope.communityId }, pin) === scope.sourceHash &&
    maxSafeBlockAgeSeconds > 0n, "native_dance_dispatch_scope_changed");
  const rpc = danceReadPort(client);
  await assertOuterCurrent();
  await assertPublicDancePublisher(retained, store, custody, lease);
  const leaseFile = pinNativeDanceEffectFile(join(lease.directory, "active-operation.json"), 65_536);
  const composerIntent = pinNativeDanceEffectFile(join(custody.composer.path, "selection-intent.json"),
    65_536, custody.composer.intentSha256);
  const holder = structuredClone(lease.holder);

  function assertPublisherCurrentSync(assertOriginalCurrent?: () => void) {
    const frame = readFileSync("/proc/self/stat", "utf8");
    const fields = frame.slice(frame.lastIndexOf(")") + 2).split(/\s+/);
    assert(holder.hostPid === process.pid && holder.uid === process.getuid!() &&
      holder.hostStartTicks === fields[19] && holder.hostGroup === Number(fields[2]) &&
      holder.hostSession === Number(fields[3]) &&
      holder.pidNamespace === readlinkSync("/proc/self/ns/pid") &&
      holder.networkNamespace === readlinkSync("/proc/self/ns/net"),
      "native_dance_dispatch_lease_changed");
    leaseFile();
    assertPinnedNativeDanceStoreConnectionSync(store, custody.store, lease);
    const composer = lstatSync(custody.composer.path, { bigint: true });
    assert(realpathSync(custody.composer.path) === custody.composer.path && composer.isDirectory() &&
      composer.uid === BigInt(process.getuid!()) && !(composer.mode & 0o077n) &&
      String(composer.dev) === custody.composer.device && String(composer.ino) === custody.composer.inode,
      "native_dance_dispatch_composer_changed");
    composerIntent();
    assertOriginalCurrent?.();
    assert(assertOwnerIssueCurrent() === true, "native_dance_dispatch_owner_fence_unavailable");
  }

  await lease.assertHeld();
  assertPublisherCurrentSync();
  let dispatching = false;

  function assertDispatchCurrentSync(request: NativeDanceDispatchRequest, expiresAtMs: number,
    assertOriginalCurrent: () => void) {
    request.signal.throwIfAborted();
    assert(request.assertHostCurrent() === true, "native_dance_dispatch_host_fence_unavailable");
    assertPublisherCurrentSync(assertOriginalCurrent);
    request.signal.throwIfAborted();
    assertNativeDanceDispatchProofCurrent(expiresAtMs);
  }

  function proofDeadlineAtIssue(request: NativeDanceDispatchRequest, proof: NativeDanceDispatchProof,
    assertOriginalCurrent: () => void) {
    const { calldata, expiresAtMs } = proof;
    assert(calldata === request.calldata, "native_dance_dispatch_primary_changed");
    assertDispatchCurrentSync(request, expiresAtMs, assertOriginalCurrent);
    return expiresAtMs;
  }

  async function current(signal: AbortSignal) {
    signal.throwIfAborted();
    await assertOuterCurrent();
    await assertPublicDancePublisher(retained, store, custody, lease);
    await lease.assertHeld();
    const sync = store.sql.exec<{ synchronous: number }>("PRAGMA synchronous").toArray();
    const journal = store.sql.exec<{ journal_mode: string }>("PRAGMA journal_mode").toArray();
    assert(sync.length === 1 && sync[0]!.synchronous >= 2 && journal.length === 1 &&
      ["delete", "truncate", "persist", "wal"].includes(journal[0]!.journal_mode),
      "native_dance_dispatch_store_not_durable");
    signal.throwIfAborted();
  }

  async function safe(signal: AbortSignal) {
    const [chain, genesis, anchor] = await Promise.all([rpc.chainId(), rpc.block(0n), rpc.safe()]);
    await current(signal);
    const now = BigInt(Math.floor(Date.now() / 1000));
    assert(chain === chainId && genesis.hash === custody.composer.genesisHash &&
      anchor.number >= pin.deploymentBlock && anchor.timestamp <= now &&
      now - anchor.timestamp <= maxSafeBlockAgeSeconds, "native_dance_dispatch_chain_changed");
    return anchor;
  }

  async function reconcile(signal: AbortSignal) {
    await current(signal);
    const start = store.get<SigningStart>(nativeDancePublisherHoldKey);
    if (!start) return;
    const ref = nativeDanceReference(start.reference), calldata = nativeDanceRaw(start.calldata);
    assertNativeDanceScope(ref, scope);
    const expected = checkedCommand(ref, calldata);
    const attempt = await retained.read(store, ref, calldata, signal);
    const command = commandKey(ref.original.commandId), index = nonceKey(start.nonce);
    const saved = store.get<{ broadcast: string }>(command);
    assert(attempt && attempt.nonce === start.nonce && saved?.broadcast === "attempted" &&
      canonical(store.get(index)) === canonical(saved), "native_dance_dispatch_original_held");
    await safe(signal);
    const status = await observeDanceV2Original({
      client, original: ref.original, expected, pin, attempt,
      async assertCurrent() {
        const still = await retained.read(store, ref, calldata, signal);
        assert(canonical(still) === canonical(attempt), "native_dance_dispatch_original_changed");
        await current(signal);
      },
    });
    assert(status === "confirmed", "native_dance_dispatch_original_held");
    await current(signal);
    // Canonical verification awaits several final RPC reads. Re-pin the exact
    // file and both indexes after those reads and before releasing the hold.
    const unchanged = await retained.read(store, ref, calldata, signal);
    assert(canonical(unchanged) === canonical(attempt), "native_dance_dispatch_original_changed");
    assertPublisherCurrentSync();
    signal.throwIfAborted();
    store.transaction(() => {
      assert(canonical(store.get(nativeDancePublisherHoldKey)) === canonical(start) &&
        store.get("op:nonce") === attempt.nonce + 1 &&
        canonical(store.get(command)) === canonical(saved) &&
        canonical(store.get(index)) === canonical(saved), "native_dance_dispatch_journal_changed");
      store.delete(nativeDancePublisherHoldKey);
    });
  }

  async function preflight(ref: NativeDanceRetainedReference, tx: TransactionSerializableLegacy,
    nonce: number, signal: AbortSignal, signedBytes?: TransactionSerializedLegacy) {
    const anchor = await safe(signal);
    const at = { blockHash: anchor.hash, requireCanonical: true } as const;
    const quote = {
      account: publisher, to: verifier, data: tx.data!, value: 0n,
      gasPrice: tx.gasPrice, blockNumber: anchor.number,
    } as const;
    const serialized = signedBytes ?? serializeTransaction(tx);
    // Allow the maximum legacy EIP-155 signature growth above the unsigned RLP.
    const sizeBound = BigInt((serialized.length - 2) / 2 + (signedBytes ? 0 : 80));
    const [code, command, gas, networkPrice, l1, operator, balance, safeNonce, latestNonce, pendingNonce] = await Promise.all([
      client.getCode({ address: verifier, ...at }),
      client.readContract({
        address: verifier, abi: danceVerdictsAbi, functionName: "commandReceipts",
        args: [publisher, ref.original.commandId], ...at,
      }),
      client.estimateGas(quote),
      client.getGasPrice(),
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "getL1FeeUpperBound", args: [sizeBound], ...at }),
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [tx.gas!], ...at }),
      client.getBalance({ address: publisher, ...at }),
      client.getTransactionCount({ address: publisher, ...at }),
      client.getTransactionCount({ address: publisher, blockTag: "latest" }),
      client.getTransactionCount({ address: publisher, blockTag: "pending" }),
    ]);
    await current(signal);
    assert(code && keccak256(code) === pin.runtimeCodeHash &&
      canonical(command.map(String)) === canonical([zeroHash, "0", zeroHash, "0", "0"]),
      "native_dance_dispatch_contract_changed");
    assert(gas > 0n && gas <= tx.gas! && networkPrice <= tx.gasPrice! &&
      l1 + operator <= BigInt(fee.dataFee) && balance >= tx.gas! * tx.gasPrice! + l1 + operator,
      "native_dance_dispatch_fee_refused");
    assert(safeNonce === nonce && latestNonce === nonce && pendingNonce === nonce,
      "native_dance_dispatch_nonce_unsettled");
    assert((await rpc.block(anchor.number)).hash === anchor.hash, "native_dance_dispatch_chain_changed");
    await current(signal);
  }

  return Object.freeze({
    assertBinding(selected: object, selectedLease: OperationLease, selectedRetained: NativeDanceRetainedStore,
      selectedCustody: Readonly<Web2PublicDanceCustody>) {
      assert(selected === store && selectedLease === lease && selectedRetained === retained &&
        canonical(selectedCustody) === canonical(custody), "native_dance_dispatch_custody_changed");
    },
    async execute(request: NativeDanceDispatchRequest) {
      assert(!dispatching, "native_dance_dispatch_busy");
      dispatching = true;
      const { signal } = request;
      try {
        const ref = nativeDanceReference(structuredClone(request.reference));
        const calldata = nativeDanceRaw(request.calldata);
        assertNativeDanceScope(ref, scope);
        checkedCommand(ref, calldata);
        await current(signal);
        const otherOriginal = await retained.read(store, ref, calldata, signal);
        await current(signal);
        if (otherOriginal) return { nonce: otherOriginal.nonce, hash: otherOriginal.hash };
        await reconcile(signal);
        await assertSignerCurrent();
        await current(signal);
        const nonce = store.get<number>("op:nonce");
        assert(typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0 &&
          nonce < 2 ** 32 - 1, "native_dance_dispatch_nonce_unavailable");
        const gasPrice = BigInt(fee.gasPrice), gas = BigInt(fee.gas);
        const tx = Object.freeze({
          type: "legacy", chainId, nonce, to: verifier, data: calldata, value: 0n, gas, gasPrice,
        } satisfies TransactionSerializableLegacy);
        await preflight(ref, tx, nonce, signal);
        const signingHash = keccak256(serializeTransaction(tx));
        const id = ref.original.commandId;
        const start: SigningStart = { reference: ref, calldata, nonce };
        const command = commandKey(id), index = nonceKey(nonce);
        const step = "10-original-" + id.slice(2);
        const originalFile = join(custody.composer.path, step + ".original.json");
        function assertOriginalAbsent() {
          assert(lstatSync(originalFile, { throwIfNoEntry: false }) === undefined,
            "native_dance_dispatch_original_changed");
        }
        function assertEmpty() {
          assert(store.get(command) === undefined && store.get(index) === undefined &&
            store.get("tx:" + nonceSuffix(nonce)) === undefined, "native_dance_dispatch_journal_changed");
        }
        assert(await retained.read(store, ref, calldata, signal) === null, "native_dance_dispatch_original_changed");
        let signingEntered = false;
        let issuedRaw: TransactionSerializedLegacy | undefined;
        const raw = await withKey(async bytes => {
          assert(!signingEntered, "native_dance_dispatch_signer_reentered");
          signingEntered = true;
          const privateKey = bytesToHex(bytes);
          const account = requireDedicatedManagedSigner(privateKey, rpcUrl.href);
          assert(account.address.toLowerCase() === publisher, "native_dance_dispatch_signer_changed");
          const signingInput = { hash: signingHash, privateKey };
          assert(await client.getTransactionCount({ address: publisher, blockTag: "pending" }) === nonce,
            "native_dance_dispatch_nonce_unsettled");
          await current(signal);
          // The managed key acquisition has already finished. This is the
          // last asynchronous authority check before recording and signing.
          const signExpiresAtMs = proofDeadlineAtIssue(request, await request.revalidate(), assertOriginalAbsent);
          store.transaction(() => {
            assert(store.get(nativeDancePublisherHoldKey) === undefined && store.get("op:nonce") === nonce,
              "native_dance_dispatch_journal_changed");
            assertEmpty();
            assertNativeDanceDispatchProofCurrent(signExpiresAtMs);
            store.set(nativeDancePublisherHoldKey, start);
            store.set("op:nonce", nonce + 1);
          });
          // In pinned viem, sign enters secp256k1 before yielding. The
          // transaction helper awaits serialization before it reaches the key.
          assertDispatchCurrentSync(request, signExpiresAtMs, assertOriginalAbsent);
          const signature = await signHash(signingInput);
          const signed = serializeTransaction(tx, signature);
          issuedRaw = signed;
          return signed;
        });
        assert(issuedRaw && raw === issuedRaw, "native_dance_dispatch_signer_unavailable");
        const hash = keccak256(raw);
        const signed = nativeDanceAttempt({ nonce, raw, hash });
        assert(signed, "native_dance_dispatch_signature_changed");
        const decoded = parseTransaction(raw);
        assert(decoded.type === "legacy" && decoded.chainId === chainId && decoded.nonce === nonce &&
          decoded.to?.toLowerCase() === verifier && decoded.data === calldata && (decoded.value ?? 0n) === 0n &&
          decoded.gas === gas && decoded.gasPrice === gasPrice &&
          (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() === publisher,
          "native_dance_dispatch_signature_changed");
        await current(signal);
        const original = {
          commandId: id, commandHash: ref.original.commandHash, target: verifier, data: calldata,
          ...signed, broadcast: "retained-unsent",
        } as const;
        const originalBytes = canonical({
          runId: custody.composer.runId, step, chainId, genesisHash: custody.composer.genesisHash,
          sender: publisher, nonce, gas: String(gas), gasPrice: String(gasPrice), to: verifier,
          data: calldata, transactionHash: hash, raw, value: "0", commandHash: original.commandHash,
        });
        await retainDanceActivationArtifact(originalFile, originalBytes, 32 * 1024);
        await syncDirectory(custody.composer.path);
        const pinnedOriginal = pinNativeDanceEffectFile(originalFile, 32 * 1024, sha256(originalBytes));
        await current(signal);
        function checkStart() {
          assert(canonical(store.get(nativeDancePublisherHoldKey)) === canonical(start) && store.get("op:nonce") === nonce + 1,
            "native_dance_dispatch_journal_changed");
        }
        store.transaction(() => {
          checkStart();
          assertEmpty();
          store.set(command, original);
          store.set(index, original);
        });

        await preflight(ref, tx, nonce, signal, raw);
        await assertSignerCurrent();
        const retainedAttempt: NativeDanceSigned | null = await retained.read(store, ref, calldata, signal);
        assert(canonical(retainedAttempt) === canonical(signed), "native_dance_dispatch_original_changed");
        assert(await client.getTransactionCount({ address: publisher, blockTag: "pending" }) === nonce,
          "native_dance_dispatch_nonce_unsettled");
        await current(signal);
        const submission = new Request(rpcUrl.href, {
          method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
        });
        // Issue from this process. A delegated RPC transport must not put an
        // awaited hook between the final Workerd check and the actual request.
        const sendExpiresAtMs = proofDeadlineAtIssue(request, await request.revalidate(), pinnedOriginal);
        store.transaction(() => {
          checkStart();
          assert(canonical(store.get(command)) === canonical(original) &&
            canonical(store.get(index)) === canonical(original), "native_dance_dispatch_journal_changed");
          const attempted = { ...original, broadcast: "attempted" };
          assertNativeDanceDispatchProofCurrent(sendExpiresAtMs);
          store.set(command, attempted);
          store.set(index, attempted);
        });
        assertDispatchCurrentSync(request, sendExpiresAtMs, pinnedOriginal);
        const response = await fetch(submission);
        const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
          await publicationResponseBytes(response, 8192),
        ));
        assert(reply?.jsonrpc === "2.0" && reply.id === 1 && !Object.hasOwn(reply, "error") && reply.result === hash,
          "native_dance_dispatch_reply_changed");
        await current(signal);
        return { nonce, hash };
      } finally {
        dispatching = false;
      }
    },
  });
}
export type NativeDanceDispatch = Awaited<ReturnType<typeof createNativeDanceDispatch>>;
