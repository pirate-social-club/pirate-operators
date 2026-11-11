import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import type { ResultsTarget } from "./learning-contract.ts";

export interface StudyWithdrawalSource {
  target: ResultsTarget;
  communityId: Hex;
  /** Exact admitted deployed runtime, including constructor immutables. */
  runtimeCodeHash: Hex;
}
export interface OriginalStudyWithdrawal {
  nonce: string;
  data: Hex;
  transaction: { raw: Hex; hash: Hex; nonce: number; sender: Address };
}
export interface StudyWithdrawalProof {
  schema: "pirate.study.linked-withdrawal-proof/1";
  kind: "observed" | "success" | "reverted" | "authority_covered";
  source: StudyWithdrawalSource;
  learner: Address;
  /** Successful on-chain withdrawal cutoff, never a fabricated revert time. */
  revokedAtS: number;
  /** Fresh linked permission must be strictly later than this recovery floor. */
  issuanceFloorS: number;
  nextNonce: string;
  anchor: { number: string; hash: Hex; timestampS: number };
  original?: {
    nonce: string;
    transactionHash: Hex;
    receipt?: {
      blockNumber: string;
      blockHash: Hex;
      status: "success" | "reverted";
    };
  };
  proofHash: Hex;
}
const hex = (x: unknown, size: number): x is Hex =>
  typeof x === "string" &&
  new RegExp(`^0x[0-9a-fA-F]{${size}}$`).test(x) &&
  BigInt(x) > 0n;
const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
const uint = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n;
function seconds(x: bigint) {
  check(
    x >= 0n && x <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
    "study_withdrawal_time_invalid",
  );
  return Number(x);
}
const position = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const revokedFields = parseAbiParameters("uint64 nonce,uint64 revokedAt");

/** Read-only proof. Unknown, malformed, unsupported hash reads and conflicting
 * anchors all return pending. No transaction is sent or replaced here. */
export async function observeStudyWithdrawal(input: {
  client: PublicClient;
  source: StudyWithdrawalSource;
  learner: Address;
  original?: OriginalStudyWithdrawal;
}): Promise<StudyWithdrawalProof | null> {
  try {
    const { client, source, original } = input,
      target = source.target,
      learner = input.learner.toLowerCase() as Address;
    check(
      target.version === 4 &&
        [6343, 31337].includes(target.chainId) &&
        hex(target.contract, 40) &&
        hex(source.communityId, 64) &&
        hex(source.runtimeCodeHash, 64) &&
        hex(learner, 40) &&
        (await client.getChainId()) === target.chainId,
      "study_withdrawal_source_changed",
    );
    const anchor = await client.getBlock({ blockTag: "safe" });
    check(
      uint(anchor.number) && hex(anchor.hash, 64) && anchor.timestamp > 0n,
      "study_withdrawal_anchor_unavailable",
    );
    const block = { blockHash: anchor.hash, requireCanonical: true } as const;
    const at = {
      address: target.contract,
      abi: resultsV4Abi,
      ...block,
    } as const;
    const [code, version, community, revokedAt, nextNonce] = await Promise.all([
      client.getCode({ address: target.contract, ...block }),
      client.readContract({ ...at, functionName: "VERSION" }),
      client.readContract({ ...at, functionName: "communityId" }),
      client.readContract({
        ...at,
        functionName: "revokedAt",
        args: [learner],
      }),
      client.readContract({
        ...at,
        functionName: "nextNonce",
        args: [learner],
      }),
    ]);
    check(
      code &&
        code !== "0x" &&
        same(keccak256(code), source.runtimeCodeHash) &&
        Number(version) === 4 &&
        same(community, source.communityId) &&
        uint(revokedAt) &&
        uint(nextNonce) &&
        revokedAt <= anchor.timestamp &&
        nextNonce < 1n << 64n &&
        (revokedAt === 0n ? nextNonce === 0n : nextNonce > 0n),
      "study_withdrawal_source_changed",
    );
    let kind: StudyWithdrawalProof["kind"] = "observed",
      floor = revokedAt;
    let retained: StudyWithdrawalProof["original"];
    if (original) {
      check(
        /^(0|[1-9][0-9]{0,19})$/.test(original.nonce) &&
          BigInt(original.nonce) < 1n << 64n,
        "study_withdrawal_original_changed",
      );
      const expected = original.transaction,
        parsed = parseTransaction(expected.raw);
      const decoded = decodeFunctionData({
        abi: resultsV4Abi,
        data: original.data,
      });
      check(
        decoded.functionName === "revoke" &&
          same(decoded.args[0], learner) &&
          decoded.args[1] === BigInt(original.nonce) &&
          encodeFunctionData({
            abi: resultsV4Abi,
            functionName: "revoke",
            args: decoded.args,
          }) === original.data &&
          same(keccak256(expected.raw), expected.hash) &&
          parsed.chainId === target.chainId &&
          same(parsed.to, target.contract) &&
          parsed.data === original.data &&
          parsed.nonce === expected.nonce &&
          (parsed.value === undefined || parsed.value === 0n) &&
          same(
            await recoverTransactionAddress({
              // parseTransaction above has already validated the wire format.
              serializedTransaction: expected.raw as TransactionSerialized,
            }),
            expected.sender,
          ),
        "study_withdrawal_original_changed",
      );
      retained = { nonce: original.nonce, transactionHash: expected.hash };
      const receipt = await client
        .getTransactionReceipt({ hash: expected.hash })
        .catch((error) => {
          if (error?.name === "TransactionReceiptNotFoundError") return null;
          throw error;
        });
      if (!receipt) {
        check(
          nextNonce > BigInt(original.nonce) && revokedAt > 0n,
          "study_withdrawal_pending",
        );
        // nextNonce belongs only to revoke; authorize does not consume it.
        // This proves authority coverage, never original transaction success.
        kind = "authority_covered";
      } else {
        check(
          same(receipt.transactionHash, expected.hash) &&
            uint(receipt.blockNumber) &&
            receipt.blockNumber <= anchor.number &&
            hex(receipt.blockHash, 64) &&
            position(receipt.transactionIndex),
          "study_withdrawal_receipt_changed",
        );
        const [ownedBlock, transaction] = await Promise.all([
          client.getBlock({ blockNumber: receipt.blockNumber }),
          client.getTransaction({ hash: expected.hash }),
        ]);
        check(
          ownedBlock.number === receipt.blockNumber &&
            same(ownedBlock.hash, receipt.blockHash) &&
            ownedBlock.timestamp > 0n &&
            ownedBlock.timestamp <= anchor.timestamp &&
            same(
              ownedBlock.transactions[receipt.transactionIndex] as Hex,
              expected.hash,
            ) &&
            same(transaction.hash, expected.hash) &&
            same(transaction.to, target.contract) &&
            same(transaction.from, expected.sender) &&
            transaction.input === original.data &&
            transaction.nonce === expected.nonce &&
            transaction.chainId === target.chainId &&
            transaction.blockNumber === receipt.blockNumber &&
            same(transaction.blockHash, receipt.blockHash) &&
            transaction.transactionIndex === receipt.transactionIndex,
          "study_withdrawal_receipt_changed",
        );
        check(
          receipt.status === "success" || receipt.status === "reverted",
          "study_withdrawal_receipt_changed",
        );
        if (receipt.status === "success") {
          const topics = encodeEventTopics({
            abi: resultsV4Abi,
            eventName: "Revoked",
            args: { learner },
          }) as Hex[];
          const expectedData = encodeAbiParameters(revokedFields, [
            BigInt(original.nonce),
            ownedBlock.timestamp,
          ]);
          const matched = receipt.logs.filter(
            (log) =>
              same(log.address, target.contract) &&
              same(log.topics[0], topics[0]!),
          );
          check(
            matched.length === 1 &&
              matched.every(
                (log) =>
                  log.removed === false &&
                  same(log.blockHash, receipt.blockHash) &&
                  log.blockNumber === receipt.blockNumber &&
                  same(log.transactionHash, expected.hash) &&
                  log.transactionIndex === receipt.transactionIndex &&
                  position(log.logIndex) &&
                  log.topics.length === topics.length &&
                  log.topics.every((t, i) => same(t, topics[i]!)) &&
                  same(log.data, expectedData),
              ) &&
              nextNonce > BigInt(original.nonce) &&
              revokedAt >= ownedBlock.timestamp,
            "study_withdrawal_event_changed",
          );
          kind = "success";
        } else {
          check(receipt.logs.length === 0, "study_withdrawal_receipt_changed");
          kind = "reverted";
          // The receipt time is an issuance floor, not a successful revokedAt.
          if (ownedBlock.timestamp > floor) floor = ownedBlock.timestamp;
        }
        retained.receipt = {
          blockNumber: String(receipt.blockNumber),
          blockHash: receipt.blockHash,
          status: receipt.status,
        };
        const reread = await client.getBlock({
          blockNumber: receipt.blockNumber,
        });
        check(
          reread.number === ownedBlock.number &&
            same(reread.hash, ownedBlock.hash!) &&
            reread.timestamp === ownedBlock.timestamp,
          "study_withdrawal_receipt_changed",
        );
      }
    } else check(revokedAt > 0n && nextNonce > 0n, "study_withdrawal_pending");
    const reread = await client.getBlock({ blockNumber: anchor.number });
    check(
      reread.number === anchor.number &&
        same(reread.hash, anchor.hash) &&
        reread.timestamp === anchor.timestamp,
      "study_withdrawal_anchor_changed",
    );
    const body = {
      schema: "pirate.study.linked-withdrawal-proof/1" as const,
      kind,
      source,
      learner,
      revokedAtS: seconds(revokedAt),
      issuanceFloorS: seconds(floor),
      nextNonce: String(nextNonce),
      anchor: {
        number: String(anchor.number),
        hash: anchor.hash,
        timestampS: seconds(anchor.timestamp),
      },
      ...(retained ? { original: retained } : {}),
    };
    return { ...body, proofHash: digest(body) as Hex };
  } catch {
    return null;
  }
}
