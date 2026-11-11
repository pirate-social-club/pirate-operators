import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Abi,
  type AbiParameter,
  type AbiParameterToPrimitiveType,
  type Address,
  type Hex,
} from "viem";
import { rewardId } from "../rewards/validation.ts";
import { danceVerdictsAbi } from "./abi.ts";
import { danceOperation, dancePayloads, danceShapes } from "./wire-shapes.ts";

export type DanceMutation = keyof typeof danceOperation;
export type DancePayload<K extends DanceMutation> = AbiParameterToPrimitiveType<
  (typeof dancePayloads)[K]
>;
export type DanceCapture = AbiParameterToPrimitiveType<
  typeof danceShapes.capture
>;
export type DanceConsent = AbiParameterToPrimitiveType<
  typeof danceShapes.consent
>;
export type DanceSubmission = AbiParameterToPrimitiveType<
  typeof danceShapes.submission
>;
export type DanceDecision = AbiParameterToPrimitiveType<
  typeof danceShapes.decision
>;
export type DancePolicy = AbiParameterToPrimitiveType<
  typeof danceShapes.policy
>;
export type DanceSourcePin = AbiParameterToPrimitiveType<
  typeof danceShapes.sourcePin
>;
export type DanceEventEvidence = AbiParameterToPrimitiveType<
  typeof danceShapes.eventEvidence
>;
export interface DanceDomain {
  chainId: bigint;
  verifier: Address;
  communityId: Hex;
}

const prefix = parseAbiParameters(
  "bytes32 domain,uint256 chainId,address verifier,bytes32 communityId",
);
const commandFields = parseAbiParameters(
  "uint8 operation,address caller,bytes32 commandId",
);
const bytes32 = parseAbiParameters("bytes32 digest");
const account = parseAbiParameters("bytes32 accountIdHash,address wallet");
const submissionId = parseAbiParameters("address learner,bytes32 captureId");
const media = parseAbiParameters(
  "bytes32 captureHash,bytes32 mediaId,uint64 generation,bytes32 recordingSha256",
);
const recordingBinding = parseAbiParameters(
  "bytes32 recordingSha256,bytes32 mediaBindingHash",
);
const reviewerConsent = parseAbiParameters(
  "bytes32 account,address wallet,bytes32 policy,uint64 acceptedAtMs",
);
const literal = (value: string) => keccak256(stringToHex(value));
const scope = (d: DanceDomain, label: string) =>
  [
    literal(`pirate.dance-${label}/1`),
    d.chainId,
    d.verifier,
    d.communityId,
  ] as const;
function committed(
  d: DanceDomain,
  label: string,
  fields: readonly AbiParameter[],
  values: readonly unknown[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [...prefix, ...fields],
      [...scope(d, label), ...values],
    ),
  );
}

export function danceCommand<K extends DanceMutation>(
  d: DanceDomain,
  name: K,
  caller: Address,
  id: Hex,
  payload: DancePayload<K>,
) {
  const parameter: AbiParameter = dancePayloads[name];
  const encoded = encodeAbiParameters([parameter], [payload]);
  const hash = committed(
    d,
    "command",
    [...commandFields, parameter],
    [danceOperation[name], caller, id, payload],
  );
  const data = encodeFunctionData<Abi, string>({
    abi: danceVerdictsAbi as Abi,
    functionName: name,
    args: [
      id,
      hash,
      name === "registerSubmission" || name === "commitVerdict"
        ? encoded
        : payload,
    ],
  });
  return { id, operation: danceOperation[name], hash, encoded, data };
}

export const danceAccountCommitment = (
  d: DanceDomain,
  id: string,
  wallet: Address,
) => committed(d, "account", account, [literal(id), wallet]);
export const danceSingletonId = (d: DanceDomain, accountCommitment: Hex) =>
  committed(d, "known-group", bytes32, [accountCommitment]);
export const danceCaptureHash = (d: DanceDomain, value: DanceCapture) =>
  committed(d, "capture", [danceShapes.capture], [value]);
export const danceConsentHash = (d: DanceDomain, value: DanceConsent) =>
  committed(d, "consent", [danceShapes.consent], [value]);
export const danceSubmissionHash = (d: DanceDomain, value: DanceSubmission) =>
  committed(d, "submission", [danceShapes.submission], [value]);
export const danceSubmissionId = (
  d: DanceDomain,
  learner: Address,
  captureId: Hex,
) => committed(d, "submission-id", submissionId, [learner, captureId]);
export const danceMediaId = (d: DanceDomain, id: string) =>
  committed(d, "media-id", bytes32, [literal(id)]);
export const danceMediaBinding = (
  d: DanceDomain,
  captureHash: Hex,
  mediaId: Hex,
  generation: bigint,
  recording: Hex,
) =>
  committed(d, "media-binding", media, [
    captureHash,
    mediaId,
    generation,
    recording,
  ]);
export const danceRecordingReplay = (d: DanceDomain, recording: Hex) =>
  committed(d, "recording-replay", bytes32, [recording]);
export const danceRecordingBinding = (
  d: DanceDomain,
  recording: Hex,
  binding: Hex,
) => committed(d, "recording-binding", recordingBinding, [recording, binding]);
export const danceOfferId = (d: DanceDomain, id: string) =>
  committed(d, "offer-id", bytes32, [literal(rewardId(id))]);
export const danceReviewerConsent = (
  d: DanceDomain,
  account: Hex,
  reviewer: Address,
  policy: Hex,
  acceptedAtMs: bigint,
) =>
  committed(d, "reviewer-consent", reviewerConsent, [
    account,
    reviewer,
    policy,
    acceptedAtMs,
  ]);
export const danceSourceHash = (d: DanceDomain, value: DanceSourcePin) =>
  committed(d, "verdict-source", [danceShapes.sourcePin], [value]);
export const danceEventEvidenceHash = (
  d: DanceDomain,
  value: DanceEventEvidence,
) => committed(d, "event-evidence", [danceShapes.eventEvidence], [value]);
export const dancePolicyHash = (value: DancePolicy) =>
  keccak256(
    encodeAbiParameters(
      [bytes32[0], danceShapes.policy],
      [literal("pirate.dance-policy/1"), value],
    ),
  );

/** The contract stores immutable static ABI preimages. Refuse noncanonical or
 * trailing data and verify that both tuples name the committed submission. */
export function decodeDanceRegistration(
  d: DanceDomain,
  captureAbi: Hex,
  submissionAbi: Hex,
  expected: Hex,
) {
  const [capture] = decodeAbiParameters([danceShapes.capture], captureAbi);
  const [submission] = decodeAbiParameters(
    [danceShapes.submission],
    submissionAbi,
  );
  if (
    encodeAbiParameters([danceShapes.capture], [capture]).toLowerCase() !==
      captureAbi.toLowerCase() ||
    encodeAbiParameters(
      [danceShapes.submission],
      [submission],
    ).toLowerCase() !== submissionAbi.toLowerCase() ||
    danceCaptureHash(d, capture) !== submission.captureHash ||
    danceSubmissionHash(d, submission) !== expected ||
    danceSubmissionId(d, capture.learner, capture.captureId) !==
      submission.submissionId
  )
    throw Error("dance_registration_preimage_mismatch");
  return { capture, submission };
}
