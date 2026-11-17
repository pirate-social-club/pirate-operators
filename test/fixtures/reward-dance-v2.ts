/** Scripted read-only RPC bytes using the actual V2 ABI/wire hashes. These are
 * not deployed-chain, real media, private-store or provider acceptance receipts. */
import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  stringToHex,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { hashJson, object } from "../../packages/community/common.ts";
import { danceVerdictsAbi } from "../../packages/dance-chain/v2/abi.ts";
import { danceShapes } from "../../packages/dance-chain/v2/wire-shapes.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  danceConsentHash,
  danceMediaBinding,
  danceOfferId,
  danceRecordingBinding,
  danceRecordingReplay,
  danceSingletonId,
  danceSourceHash,
  danceSubmissionHash,
  danceSubmissionId,
  type DanceCapture,
  type DanceSubmission,
} from "../../packages/dance-chain/v2/wire.ts";
import { songKeyOf } from "../../packages/protocol/records.ts";
import type { RewardOfferInput } from "../../packages/rewards/contracts.ts";
import type { DancePublicationSourceV2 } from "../../services/dance-publication-source.ts";
import type { RewardDanceV2Proofs } from "../../services/reward-dance-v2-reader.ts";

export const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
export const address = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}`;
export const accountA = "11111111-1111-4111-8111-111111111111";
export const accountB = "22222222-2222-4222-8222-222222222222";
const event = danceVerdictsAbi.find(
  (x) => x.type === "event" && x.name === "VerdictCommittedV2",
)!;
const dataShape = event.inputs.filter(
  (x) => !x.indexed,
) as readonly AbiParameter[];

export function rewardDanceV2Fixture() {
  const baseS = 1_800_000_000n,
    code = "0x60006000f3" as Hex,
    codeHash = keccak256(code);
  const domain = { chainId: 6343n, communityId: word(1), verifier: address(2) };
  const pin = {
    directory: address(3),
    directoryRuntimeHash: codeHash,
    consentRegistry: address(4),
    consentRegistryRuntimeHash: codeHash,
    posts: address(5),
    postsRuntimeHash: codeHash,
    executionRule: keccak256(stringToHex("directory-current-publisher/1")),
    learnerConsentPolicyHash: word(6),
    reviewerConsentPolicyHash: word(7),
    publicityPolicyHash: word(8),
    rulesSha256: word(9),
    termsSha256: word(10),
    rubricSha256: word(11),
    mediaPolicySha256: word(12),
    deploymentBlock: 10n,
    runtimeCodeHash: codeHash,
  };
  const source: DancePublicationSourceV2 = {
    version: 2,
    domain,
    pin,
    sourceHash: danceSourceHash(domain, pin),
    capturePolicy: address(13),
    capturePolicyRuntimeHash: codeHash,
  };
  const song = {
    chainId: domain.chainId,
    posts: pin.posts,
    communityId: domain.communityId,
    postId: word(14),
    revision: 1n,
    manifestSha256: word(15),
    audioSha256: word(16),
  };
  const offer: RewardOfferInput = {
    offerId: "offer_fixture_v2",
    drawingId: "17",
    songKey: songKeyOf({ ...song, chainId: 6343 }),
    opensAt: Number(baseS * 1000n),
    cutoffAt: Number((baseS + 5n) * 1000n),
    purchaseHash: word(17),
    ticketIds: ["18"],
    resultSources: [source.sourceHash],
  };
  const inputHash = hashJson(offer);
  type RpcBlockObservation = {
    number: bigint;
    hash: Hex;
    timestamp: bigint;
    transactions: Hex[];
  };
  const blocks = new Map<bigint, RpcBlockObservation>(
    Array.from({ length: 7 }, (_, i) => {
      const number = BigInt(i + 10);
      const observation: RpcBlockObservation = {
        number,
        hash: word(i + 100),
        timestamp: baseS + BigInt(i - 1),
        transactions: [],
      };
      return [number, observation] as const;
    }),
  );
  // This is the caller's captured value, not a live alias of RPC observations.
  const cutoff: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }> =
    Object.freeze({
      number: 15n,
      hash: blocks.get(15n)!.hash,
      timestamp: blocks.get(15n)!.timestamp,
    });
  type Log = {
    address: Address;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
    removed: boolean;
    data: Hex;
    topics: Hex[];
  };
  const events: {
    log: Log;
    receipt: {
      status: "0x1" | "0x0";
      blockNumber: bigint;
      blockHash: Hex;
      transactionHash: Hex;
      transactionIndex: number;
      logs: Log[];
    };
    capture: DanceCapture;
    submission: DanceSubmission;
    registration: [Hex, Hex, Hex];
    verdict: {
      commandHash: Hex;
      submissionHash: Hex;
      reviewerAccountCommitment: Hex;
      reviewerWallet: Address;
      committedAtSeconds: bigint;
      category: number;
      withinFrozenOfferWindow: boolean;
    };
    encodeEvent(): void;
  }[] = [];
  const retained = new Map<Hex, { accountId: string; capture: DanceCapture }>();
  const state = {
    chainId: 6343,
    version: 2,
    sourceHash: source.sourceHash,
    songVerified: true,
    reads: [] as string[],
    proofReads: [] as string[],
    safeNumber: 16n,
    codes: new Map(
      [
        domain.verifier,
        pin.directory,
        pin.consentRegistry,
        pin.posts,
        source.capturePolicy,
      ].map((a) => [a, code]),
    ),
    onRead: undefined as ((method: string) => void) | undefined,
  };
  function add(
    options: {
      accountId?: string;
      wallet?: Address;
      block?: bigint;
      category?: number;
      changeCapture?: (capture: DanceCapture) => void;
    } = {},
  ) {
    const i = events.length,
      block = blocks.get(options.block ?? 12n)!;
    const accountId = options.accountId ?? accountA,
      learner = options.wallet ?? address(20);
    const commitment = danceAccountCommitment(domain, accountId, learner);
    const capture: DanceCapture = {
      captureId: word(200 + i),
      accountCommitment: commitment,
      learner,
      identityEpoch: 1n,
      groupId: danceSingletonId(domain, commitment),
      groupEpoch: 1n,
      publicationGrantId: word(300 + i),
      reservedAtMs: baseS * 1000n,
      song: structuredClone(song),
      rulesSha256: pin.rulesSha256,
      termsSha256: pin.termsSha256,
      rubricSha256: pin.rubricSha256,
      mediaPolicySha256: pin.mediaPolicySha256,
      referenceSelection: {
        present: false,
        id: word(0),
        revision: 0n,
        epoch: 0n,
        segmentLayoutSha256: word(0),
        segmentId: word(0),
        startSample: 0n,
        durationSamples: 288000n,
      },
      offer: {
        present: true,
        offerIdCommitment: danceOfferId(domain, offer.offerId),
        inputHash,
        sourceHash: source.sourceHash,
        opensAtMs: BigInt(offer.opensAt),
        cutoffAtMs: BigInt(offer.cutoffAt),
      },
    };
    options.changeCapture?.(capture);
    const captureHash = danceCaptureHash(domain, capture),
      recording = word(400 + i);
    const binding = danceMediaBinding(
      domain,
      captureHash,
      word(500 + i),
      1n,
      recording,
    );
    const submission: DanceSubmission = {
      submissionId: danceSubmissionId(domain, learner, capture.captureId),
      captureHash,
      consentHash: danceConsentHash(domain, {
        accepted: true,
        acceptedAtMs: capture.reservedAtMs,
        captureHash,
        termsSha256: pin.termsSha256,
        publicityPolicyHash: pin.publicityPolicyHash,
      }),
      mediaBindingHash: binding,
      mediaIdCommitment: word(500 + i),
      mediaGeneration: 1n,
      recordingReplayKey: danceRecordingReplay(domain, recording),
      recordingBindingHash: danceRecordingBinding(domain, recording, binding),
      trustedSubmittedAtMs: capture.reservedAtMs,
      reviewDeadlineMs: (baseS + 600n) * 1000n,
      mediaExpiresAtMs: (baseS + 700n) * 1000n,
    };
    const verdict = {
      commandHash: word(600 + i),
      submissionHash: danceSubmissionHash(domain, submission),
      reviewerAccountCommitment: word(700),
      reviewerWallet: address(21),
      committedAtSeconds: block.timestamp,
      category: options.category ?? 1,
      withinFrozenOfferWindow:
        (options.category ?? 1) === 1 &&
        capture.offer.present &&
        block.timestamp * 1000n >= capture.offer.opensAtMs &&
        block.timestamp * 1000n < capture.offer.cutoffAtMs,
    };
    const tx = word(800 + i),
      transactionIndex = block.transactions.length;
    block.transactions.push(tx);
    const log: Log = {
      address: domain.verifier,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: tx,
      transactionIndex,
      logIndex: transactionIndex,
      removed: false,
      data: "0x",
      topics: [],
    };
    const item = {
      log,
      receipt: {
        status: "0x1" as "0x1" | "0x0",
        blockNumber: block.number,
        blockHash: block.hash,
        transactionHash: tx,
        transactionIndex,
        logs: [] as Log[],
      },
      capture,
      submission,
      verdict,
      registration: [
        encodeAbiParameters([danceShapes.capture], [capture]),
        encodeAbiParameters([danceShapes.submission], [submission]),
        verdict.submissionHash,
      ] as [Hex, Hex, Hex],
      encodeEvent() {
        log.topics = encodeEventTopics({
          abi: danceVerdictsAbi,
          eventName: "VerdictCommittedV2",
          args: {
            submissionId: submission.submissionId,
            commandId: word(900 + i),
            learner,
          },
        }) as Hex[];
        log.data = encodeAbiParameters(dataShape, [
          capture.accountCommitment,
          source.sourceHash,
          verdict,
          capture.publicationGrantId,
          word(701),
          1n,
        ]);
        this.receipt.logs = [structuredClone(log)];
      },
    };
    item.encodeEvent();
    events.push(item);
    retained.set(capture.captureId, {
      accountId,
      capture: structuredClone(capture),
    });
    return item;
  }
  const rawLog = (l: Log) => ({
    ...l,
    blockNumber: `0x${l.blockNumber.toString(16)}`,
    transactionIndex: `0x${l.transactionIndex.toString(16)}`,
    logIndex: `0x${l.logIndex.toString(16)}`,
  });
  const client = createPublicClient({
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }) {
          state.reads.push(method);
          state.onRead?.(method);
          if (method === "eth_chainId")
            return `0x${state.chainId.toString(16)}`;
          if (method === "eth_getBlockByNumber") {
            const b = blocks.get(
              params?.[0] === "safe"
                ? state.safeNumber
                : BigInt(String(params?.[0])),
            );
            assert.ok(b, "every requested canonical fixture block must exist");
            return {
              ...b,
              number: `0x${b.number.toString(16)}`,
              timestamp: `0x${b.timestamp.toString(16)}`,
              parentHash: word(999),
            };
          }
          if (method === "eth_getLogs") {
            const p = object(params?.[0]);
            assert.equal(p.address, domain.verifier);
            assert.deepEqual(p.topics, [
              encodeEventTopics({
                abi: danceVerdictsAbi,
                eventName: "VerdictCommittedV2",
              })[0],
            ]);
            return events
              .filter(
                (e) =>
                  e.log.blockNumber >= BigInt(String(p.fromBlock)) &&
                  e.log.blockNumber <= BigInt(String(p.toBlock)),
              )
              .map((e) => rawLog(e.log));
          }
          if (method === "eth_getTransactionReceipt") {
            const e = events.find(
              (e) => e.receipt.transactionHash === params?.[0],
            );
            if (!e) return null;
            const r = e.receipt;
            return {
              ...r,
              blockNumber: `0x${r.blockNumber.toString(16)}`,
              transactionIndex: `0x${r.transactionIndex.toString(16)}`,
              logs: r.logs.map(rawLog),
              gasUsed: "0x1",
              cumulativeGasUsed: "0x1",
              effectiveGasPrice: "0x1",
              type: "0x2",
            };
          }
          assert.ok(
            method === "eth_call" || method === "eth_getCode",
            "no writes or unplanned RPC methods",
          );
          const at = object(params?.[1]);
          assert.equal(
            at.requireCanonical,
            true,
            "all state observations use canonical hash anchoring",
          );
          assert.ok([...blocks.values()].some((b) => b.hash === at.blockHash));
          if (method === "eth_getCode")
            return state.codes.get(params?.[0] as Address) ?? "0x";
          const call = object(params?.[0]);
          assert.equal(call.to, domain.verifier);
          const decoded = decodeFunctionData({
            abi: danceVerdictsAbi,
            data: call.data as Hex,
          });
          state.reads.push(decoded.functionName);
          switch (decoded.functionName) {
            case "VERSION":
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "VERSION",
                result: state.version,
              });
            case "sourceHash":
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "sourceHash",
                result: state.sourceHash,
              });
            case "communityId":
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "communityId",
                result: domain.communityId,
              });
            case "capturePolicy":
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "capturePolicy",
                result: source.capturePolicy,
              });
            case "capturePolicyRuntimeHash":
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "capturePolicyRuntimeHash",
                result: source.capturePolicyRuntimeHash,
              });
            case "registrationOf": {
              const e = events.find(
                (e) => e.submission.submissionId === decoded.args[0],
              );
              assert.ok(e);
              return encodeFunctionResult({
                abi: danceVerdictsAbi,
                functionName: "registrationOf",
                result: e.registration,
              });
            }
            default:
              assert.fail(
                "no current account/grant/role substitution is permitted",
              );
          }
        },
      },
      { retryCount: 0 },
    ),
  });
  const proofs: RewardDanceV2Proofs = {
    async retainedCapture(request) {
      state.proofReads.push("capture");
      assert.equal(request.sourceHash, source.sourceHash);
      return structuredClone(retained.get(request.captureId) ?? null);
    },
    async authenticateSong(actual, number, hash) {
      state.proofReads.push("song");
      return (
        state.songVerified &&
        hashJson({
          ...actual,
          chainId: String(actual.chainId),
          revision: String(actual.revision),
        }) ===
          hashJson({
            ...song,
            chainId: String(song.chainId),
            revision: String(song.revision),
          }) &&
        blocks.get(number)?.hash === hash
      );
    },
  };
  return {
    source,
    offer,
    inputHash,
    cutoff,
    fromBlock: 11n,
    client,
    proofs,
    state,
    events,
    blocks,
    retained,
    add,
    baseS,
  };
}
