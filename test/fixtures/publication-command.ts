// Real SQLite operator store and real signatures; only the RPC boundary is scripted.
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex,
  type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { digest } from "../../packages/protocol/index.ts";
import { parsePublicationGrant, preparePublicationGrant } from "../../packages/protocol/publication-consent.ts";
import { publicationConsentAbi } from "../../packages/protocol/generated/publication-consent-v1.ts";
import type { ConsentSourceV1, PreparedConsentCommandV1 } from "../../packages/protocol/publication-runtime-v1.ts";
import { Store } from "../../services/operator-store.ts";
import { commandId, type CapturedPublicationFeeV1 } from "../../services/publication-command-contract.ts";
import { acceptPublicationCommand, readPublicationJob } from "../../services/publication-command-operator.ts";
import { intentOf, txRow, type TxRow } from "../../services/operator-tx.ts";
import type { PublicationReadRpc } from "../../services/publication-command-rpc.ts";

const learner = privateKeyToAccount(`0x${"71".repeat(32)}`);
const payer = privateKeyToAccount(`0x${"73".repeat(32)}`);
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
export const receiptHashA = digest("receipt-block-a"), receiptHashB = digest("receipt-block-b");
export const safeHashA = digest("safe-block-a"), safeHashB = digest("safe-block-b");
export async function publicationCommandFixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  let sequence = 0;
  const storage = {
    sql: { exec(query: string, ...args: (string | number | null)[]) {
      const rows = sqlite.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync<T>(work: () => T) {
      const point = "publication_" + sequence++;
      sqlite.exec("SAVEPOINT " + point);
      try { const result = work(); sqlite.exec("RELEASE " + point); return result; }
      catch (error) { sqlite.exec("ROLLBACK TO " + point); sqlite.exec("RELEASE " + point); throw error; }
    },
  } as unknown as DurableObjectStorage;
  const store = new Store(storage, 1800000000);
  const source: ConsentSourceV1 = {
    schema: "pirate.publication-source/1", resultsVersion: 5, chainId: 31337,
    communityId: digest("rpc-command-community"), installationId: "fixture-installation",
    directory: `0x${"11".repeat(20)}`, directoryRuntimeHash: digest("directory-code"),
    registry: `0x${"22".repeat(20)}`, registryRuntimeHash: keccak256("0x6000"),
    releaseSelectionSha256: digest("rpc-selection"),
  };
  const fee: CapturedPublicationFeeV1 = {
    schema: "pirate.publication-fee/1", chainId: 31337,
    payer: payer.address.toLowerCase() as Address, policyHash: digest("fee-policy"),
    cap: "10000000", gas: "300000", gasPrice: "1", dataFee: "0",
  };
  const message = {
    learner: learner.address.toLowerCase() as Address, communityId: source.communityId,
    purpose: "study-results" as const, publicationTarget: source.registry,
    publicationTargetRuntimeHash: source.registryRuntimeHash,
    permissionRevision: "1", policyHash: digest("study-policy"), withdrawalEpoch: "0",
    nonce: digest("rpc-grant-nonce"), issuedAt: "1800000000", validAfter: "1800000000",
    expiresAt: "1800003600", submitBefore: "1800000060",
  };
  const prepared = preparePublicationGrant(31337n, source.registry, message, "0x");
  const command: PreparedConsentCommandV1 = {
    schema: "pirate.publication-command/1", action: "grant", source,
    commandId: commandId({ source, accountId: "fixture-account", requestId: "rpc-request",
      action: "grant", purpose: message.purpose }),
    requestId: "rpc-request", accountId: "fixture-account", digest: prepared.digest,
    preparedAtMs: 1800000000000, localFenceGeneration: "0", message,
  };
  const signature = await learner.signTypedData(prepared.typed);
  acceptPublicationCommand(store, { command, signature, fee },
    { source, issuer: learner.address, operator: fee.payer }, fee);
  const job = readPublicationJob(store, command.commandId)!;
  const intent = intentOf(store, job.kind, job.ref)!;
  // Model an original allocated by a previously admitted sender. No allocation,
  // signing service or broadcast path of the proposed slice is called here.
  const raw = await payer.signTransaction({ type: "legacy", chainId: 31337,
    nonce: 0, to: source.registry, value: 0n, data: job.data, gas: 300000n, gasPrice: 1n });
  const hash = keccak256(raw);
  store.transaction(() => {
    store.set(`intent:${job.kind}:${job.ref}`, { ...intent, nonce: 0 });
    store.set("tx:0000000000", { nonce: 0, kind: job.kind, ref: job.ref,
      chainId: 31337, to: source.registry, data: job.data, gas: "300000", gasPrice: "1",
      raw, hash, broadcast: "attempted", mined: null, publicationV1: fee } satisfies TxRow);
    store.set("op:nonce", 1);
  });
  type Mode = { blockHash?: Hex; safeHash?: Hex; status?: Hex;
    omitSafeHash?: boolean; nullSafeAgain?: boolean;
    grantEvent?: boolean; grantId?: Hex; noReceipt?: boolean;
    beforeFinalBlock?: () => Promise<void> };
  const scripted = (mode: Mode = {}) => {
    const calls: { method: string; params: readonly unknown[] }[] = [];
    const blockHash = mode.blockHash ?? receiptHashA, safeHash = mode.safeHash ?? safeHashA;
    const block = { number: "0x64", hash: blockHash, timestamp: hex(1800000000n), transactions: [hash] };
    const safe = { number: "0xc8", hash: safeHash, timestamp: hex(1800000100n), transactions: [] };
    const grant = parsePublicationGrant(message);
    const event = publicationConsentAbi.find(x => x.type === "event" && x.name === "PublicationGranted")!;
    const log = { address: source.registry, transactionHash: hash, transactionIndex: "0x0",
      blockNumber: "0x64", blockHash,
      topics: encodeEventTopics({ abi: publicationConsentAbi, eventName: "PublicationGranted",
        args: { grantId: mode.grantId ?? command.digest, learner: grant.learner,
          purposeHash: keccak256(stringToHex(grant.purpose)) } }),
      data: encodeAbiParameters(event.inputs.filter(x => !x.indexed), [grant, 1800000000n]) };
    const receipt = { transactionHash: hash, transactionIndex: "0x0", blockNumber: "0x64",
      blockHash, from: fee.payer, to: source.registry, status: mode.status ?? "0x0",
      logs: mode.grantEvent ? [log] : [] };
    let numberedReceiptReads = 0;
    const read: PublicationReadRpc = async <T>(method: string, params: readonly unknown[]) => {
      calls.push({ method, params: structuredClone(params) });
      let value: unknown;
      if (method === "eth_chainId") value = "0x7a69";
      else if (method === "eth_getTransactionReceipt") value = mode.noReceipt ? null : receipt;
      else if (method === "eth_getTransactionByHash") value = {
        hash, from: fee.payer, to: source.registry, input: job.data,
        nonce: "0x0", value: "0x0", blockHash, blockNumber: "0x64", transactionIndex: "0x0",
      };
      else if (method === "eth_getCode") value = "0x6000";
      else if (method === "eth_getBlockByNumber") {
        if (params[0] === "safe") {
          const { hash: _hash, ...withoutHash } = safe;
          value = mode.omitSafeHash ? withoutHash : safe;
        } else if (params[0] === "0xc8") value = mode.nullSafeAgain ? null : safe;
        else if (params[0] === "0x64") {
          if (++numberedReceiptReads === 2) await mode.beforeFinalBlock?.();
          value = block;
        } else throw Error("unexpected block query");
      } else throw Error("unexpected RPC method: " + method);
      return structuredClone(value) as T;
    };
    return { read, calls };
  };
  return { store, command, job, hash, scripted, row: () => txRow(store, 0)! };
}
