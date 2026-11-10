import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Address,
  type AbiParameter,
  type Hex,
} from "viem";
import { hashJson } from "../packages/community/common.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { qualifyDanceVerdict } from "../packages/dance-chain/qualification.ts";
import {
  verifyDanceVerdict,
  type DanceBlock,
  type DanceCanonicalSource,
  type DanceLog,
  type DanceReadPort,
} from "../packages/dance-chain/reader.ts";
import { danceShapes } from "../packages/dance-chain/wire-shapes.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  danceCommand,
  danceConsentHash,
  danceMediaBinding,
  danceMediaId,
  danceOfferId,
  danceRecordingBinding,
  danceRecordingReplay,
  danceSingletonId,
  danceSourceHash,
  danceSubmissionHash,
  danceSubmissionId,
  type DanceCapture,
  type DanceConsent,
  type DanceSubmission,
} from "../packages/dance-chain/wire.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { RewardOfferInput } from "../packages/rewards/contracts.ts";
import { offerInput } from "../packages/rewards/offers.ts";

const word = (i: number): Hex => `0x${i.toString(16).padStart(64, "0")}`;
const address = (i: number): Address => `0x${i.toString(16).padStart(40, "0")}`;
const code: Hex = "0x60006000f3";
const timestamp = 1_800_000_000n;
const ms = timestamp * 1000n;
const domain = { chainId: 6343n, verifier: address(17), communityId: word(7) };
const recordEvent = danceVerdictsAbi.find(
  (a) => a.type === "event" && a.name === "VerdictCommitted",
)!;

function fixture() {
  const learner = address(23),
    accountId = "fixture_account_learner";
  const accountCommitment = danceAccountCommitment(domain, accountId, learner);
  const pin = {
    directory: address(1),
    directoryRuntimeHash: keccak256(code),
    v4: address(2),
    v4RuntimeHash: keccak256(code),
    posts: address(3),
    postsRuntimeHash: keccak256(code),
    fixedPublisher: address(4),
    publicityPolicyHash: word(15),
    rulesSha256: word(16),
    termsSha256: word(17),
    rubricSha256: word(18),
    mediaPolicySha256: word(19),
    deploymentBlock: 10n,
    runtimeCodeHash: keccak256(code),
  };
  const source: DanceCanonicalSource = {
    schema: "pirate.dance-verdict/1",
    domain,
    pin,
    sourceHash: danceSourceHash(domain, pin),
    capturePolicy: address(5),
    capturePolicyRuntimeHash: keccak256(code),
  };
  const song = {
    chainId: domain.chainId,
    posts: pin.posts,
    communityId: domain.communityId,
    postId: word(28),
    revision: 2n,
    manifestSha256: word(29),
    audioSha256: word(30),
  };
  const offer: RewardOfferInput = {
    offerId: "fixture_offer_1",
    drawingId: "fixture_draw_1",
    songKey: songKeyOf({ ...song, chainId: 6343 }),
    opensAt: Number(ms),
    cutoffAt: Number(ms + 1000n),
    purchaseHash: word(40),
    ticketIds: ["1"],
    resultSources: [source.sourceHash],
  };
  const inputHash = hashJson(offerInput(offer));
  const capture: DanceCapture = {
    captureId: word(41),
    accountCommitment,
    learner,
    identityEpoch: 1n,
    groupId: danceSingletonId(domain, accountCommitment),
    groupEpoch: 1n,
    authorizationId: word(42),
    reservedAtMs: ms - 4000n,
    song,
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
      durationSamples: 288_000n,
    },
    offer: {
      present: true,
      offerIdCommitment: danceOfferId(domain, offer.offerId),
      inputHash,
      sourceHash: source.sourceHash,
      opensAtMs: ms,
      cutoffAtMs: ms + 1000n,
    },
  };
  const captureHash = danceCaptureHash(domain, capture);
  const consent: DanceConsent = {
    accepted: true,
    acceptedAtMs: ms - 3000n,
    captureHash,
    termsSha256: pin.termsSha256,
    publicityPolicyHash: pin.publicityPolicyHash,
  };
  const recordingSha256 = word(43),
    mediaIdCommitment = danceMediaId(domain, "fixture-media-id");
  const mediaBindingHash = danceMediaBinding(
    domain,
    captureHash,
    mediaIdCommitment,
    2n,
    recordingSha256,
  );
  const submission: DanceSubmission = {
    submissionId: danceSubmissionId(domain, learner, capture.captureId),
    captureHash,
    consentHash: danceConsentHash(domain, consent),
    mediaBindingHash,
    mediaIdCommitment,
    mediaGeneration: 2n,
    recordingReplayKey: danceRecordingReplay(domain, recordingSha256),
    recordingBindingHash: danceRecordingBinding(
      domain,
      recordingSha256,
      mediaBindingHash,
    ),
    trustedSubmittedAtMs: ms - 2000n,
    reviewDeadlineMs: ms - 2000n + 604_800_000n,
    mediaExpiresAtMs: ms - 2000n + 604_800_000n,
  };
  const submissionHash = danceSubmissionHash(domain, submission);
  const data = encodeAbiParameters(
    recordEvent.inputs.filter((x) => !x.indexed) as readonly AbiParameter[],
    [
      accountCommitment,
      source.sourceHash,
      {
        commandHash: word(61),
        submissionHash,
        reviewerAccountCommitment: word(62),
        reviewerWallet: address(24),
        committedAtSeconds: timestamp,
        category: 1,
        withinFrozenOfferWindow: true,
      },
    ],
  );
  const commandId = word(60);
  const [signature, ...indexed] = encodeEventTopics({
    abi: danceVerdictsAbi,
    eventName: "VerdictCommitted",
    args: { submissionId: submission.submissionId, commandId, learner },
  });
  assert.ok(signature && indexed.every((value) => typeof value === "string"));
  const log: DanceLog = {
    address: domain.verifier,
    blockNumber: 20n,
    blockHash: word(51),
    transactionHash: word(52),
    transactionIndex: 1,
    logIndex: 3,
    removed: false,
    data,
    topics: [signature, ...indexed],
  };
  const eventBlock: DanceBlock = {
    number: 20n,
    hash: word(51),
    timestamp,
    transactions: [word(50), word(52)],
  };
  const safe: DanceBlock = {
    number: 22n,
    hash: word(54),
    timestamp: timestamp + 2n,
    transactions: [],
  };
  const receipt = {
    status: "success" as const,
    blockNumber: 20n,
    blockHash: word(51),
    transactionHash: word(52),
    transactionIndex: 1,
    logs: [{ ...log }],
  };
  const rpc: DanceReadPort = {
    chainId: async () => 6343,
    safe: async () => safe,
    block: async (number) => (number === 20n ? eventBlock : safe),
    code: async () => code,
    receipt: async () => receipt,
    sourceView: async () => ({
      sourceHash: source.sourceHash,
      communityId: domain.communityId,
      version: 1,
      capturePolicy: source.capturePolicy,
      capturePolicyRuntimeHash: source.capturePolicyRuntimeHash,
    }),
    registration: async () => [
      encodeAbiParameters([danceShapes.capture], [capture]),
      encodeAbiParameters([danceShapes.submission], [submission]),
      submissionHash,
    ],
  };
  return {
    source,
    rpc,
    log,
    eventBlock,
    safe,
    receipt,
    learner,
    accountId,
    accountCommitment,
    capture,
    consent,
    submission,
    recordingSha256,
    offer,
    inputHash,
  };
}

test("a canonical pass uses transaction seconds and the retained account binding", async () => {
  const f = fixture();
  const verified = await verifyDanceVerdict(f.rpc, f.source, f.log);
  assert.equal(verified.committedAtMs, Number(ms));
  assert.equal(verified.verdict, "pass");
  assert.equal(verified.provenance.transactionIndex, 1n);
  assert.equal(verified.provenance.logIndex, 3n);
  const proofs = {
    capturedAccount: async (
      sourceHash: Hex,
      accountCommitment: Hex,
      identityEpoch: bigint,
    ) => {
      assert.equal(sourceHash, f.source.sourceHash);
      assert.equal(accountCommitment, f.accountCommitment);
      assert.equal(identityEpoch, 1n);
      return {
        accountId: f.accountId,
        wallet: f.learner,
        accountCommitment,
        identityEpoch,
      };
    },
    authenticateSong: async (
      song: DanceCapture["song"],
      block: bigint,
      hash: Hex,
    ) => {
      assert.equal(song.manifestSha256, f.capture.song.manifestSha256);
      assert.equal(block, 20n);
      assert.equal(hash, f.eventBlock.hash);
      return true;
    },
  };
  assert.deepEqual(
    await qualifyDanceVerdict(f.source, verified, f.offer, f.inputHash, proofs),
    {
      accountId: f.accountId,
      wallet: f.learner,
      evidenceHash: verified.evidenceHash,
      completedAt: Number(ms),
    },
  );
  const oldOffer = { ...f.offer, resultSources: undefined };
  assert.equal(
    await qualifyDanceVerdict(
      f.source,
      verified,
      oldOffer,
      hashJson(offerInput(oldOffer)),
      proofs,
    ),
    null,
  );
  const differentOffer = { ...f.offer, offerId: "fixture_offer_2" };
  assert.equal(
    await qualifyDanceVerdict(
      f.source,
      verified,
      differentOffer,
      hashJson(offerInput(differentOffer)),
      proofs,
    ),
    null,
  );
  await assert.rejects(
    qualifyDanceVerdict(f.source, verified, f.offer, f.inputHash, {
      ...proofs,
      capturedAccount: async () => null,
    }),
    /dance_historical_account_unverified/,
  );
});

test("canonical reader refuses a removed log, different receipt bytes, and foreign transaction position", async () => {
  const f = fixture();
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, { ...f.log, removed: true }),
    /dance_log_position_invalid/,
  );
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, { ...f.log, data: "0x00" }),
    /dance_receipt_log_not_owned/,
  );
  f.receipt.transactionIndex = 0;
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, f.log),
    /dance_receipt_not_owned/,
  );
  f.receipt.transactionIndex = 1;
  f.eventBlock.transactions = [word(52), word(50)];
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, f.log),
    /dance_verdict_reorged/,
  );
});

test("matching receipt bytes cannot admit noncanonical event padding or extra words", async () => {
  const replaceByte = (value: Hex, offset: number) => {
    const index = 2 + offset * 2;
    return `${value.slice(0, index)}01${value.slice(index + 2)}` as Hex;
  };
  for (const mutate of [
    (log: DanceLog) => {
      log.data = `${log.data}${"00".repeat(32)}`;
    },
    (log: DanceLog) => {
      log.topics = [log.topics[0]!, ...log.topics.slice(1), word(99)];
    },
    (log: DanceLog) => {
      log.data = replaceByte(log.data, 5 * 32);
    },
    (log: DanceLog) => {
      log.topics[3] = replaceByte(log.topics[3]!, 0);
    },
  ]) {
    const f = fixture();
    mutate(f.log);
    f.receipt.logs[0] = { ...f.log };
    await assert.rejects(
      verifyDanceVerdict(f.rpc, f.source, f.log),
      /dance_event_encoding_invalid/,
    );
  }
});

test("a caller cannot substitute a later safe anchor and historical pin drift fails closed", async () => {
  const f = fixture();
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, f.log, {
      ...f.safe,
      number: f.safe.number + 1n,
    }),
    /dance_verdict_not_confirmed/,
  );
  f.rpc.code = async (address) =>
    address === f.source.capturePolicy ? "0x01" : code;
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, f.log),
    /dance_historical_runtime_changed/,
  );
});

test("reorg after registration read holds the event instead of qualifying it", async () => {
  const f = fixture();
  let eventReads = 0;
  f.rpc.block = async (number) =>
    number === 20n
      ? ++eventReads === 1
        ? f.eventBlock
        : { ...f.eventBlock, hash: word(99) }
      : f.safe;
  await assert.rejects(
    verifyDanceVerdict(f.rpc, f.source, f.log),
    /dance_verdict_reorged/,
  );
});

test("registration calldata carries the exact 54 static words hashed by the command", () => {
  const f = fixture();
  const command = danceCommand(
    domain,
    "registerSubmission",
    f.source.pin.fixedPublisher,
    word(80),
    {
      expectedOwnerEpoch: 1n,
      expectedConfigurationRevision: 1n,
      expectedRulesEpoch: 0n,
      expectedMediaEpoch: 0n,
      capture: f.capture,
      consent: f.consent,
      submission: f.submission,
      recordingSha256: f.recordingSha256,
    },
  );
  assert.equal((command.encoded.length - 2) / 2, 54 * 32);
  const decoded = decodeFunctionData({
    abi: danceVerdictsAbi,
    data: command.data,
  });
  if (decoded.functionName !== "registerSubmission")
    assert.fail("wrong selector");
  assert.deepEqual(decoded.args, [command.id, command.hash, command.encoded]);
});
