import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { selectedDanceRewardSource } from "../packages/dance-chain/source-selection.ts";
import { retainedDanceAccount } from "../services/dance-reward-source.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";

import { observeDanceIntent } from "../services/dance-canonical-ports.ts";
import type {
  DanceCapture as LocalCapture,
  DanceReview,
  DanceOutbox,
} from "../packages/dance/contracts.ts";
import {
  decisionIntent,
  submissionIntentPreimage,
} from "../packages/dance/intent.ts";
import { mediaBinding } from "../packages/dance/validation.ts";
import {
  canonicalDanceCapture,
  canonicalDanceDecision,
  canonicalDanceRegistration,
  reconcileCanonicalDanceVerdict,
} from "../services/dance-canonical-commands.ts";

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

test("historical D1 identity uses the exact immutable consent and capture, independent of current identity", async () => {
  const f = fixture();
  const db = new MemorySqliteD1();
  try {
    db.sqlite.exec(
      readFileSync(
        new URL("../packages/dance/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    const captureId = f.capture.captureId.slice(2);
    const capture = {
      captureId,
      captureHash: f.submission.captureHash,
      communityId: f.source.domain.communityId,
      source: { sourceHash: f.source.sourceHash },
      learner: {
        accountId: f.accountId,
        wallet: f.learner,
        active: true,
        accountCommitment: f.accountCommitment,
        identityEpoch: Number(f.capture.identityEpoch),
      },
    };
    const consent = {
      accepted: true,
      accountId: f.accountId,
      captureId,
      captureHash: capture.captureHash,
      termsHash: f.source.pin.termsSha256,
      publicityPolicyHash: f.source.pin.publicityPolicyHash,
    };
    db.sqlite
      .prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)")
      .run(
        captureId,
        capture.communityId,
        f.accountId,
        "command_1",
        word(1),
        JSON.stringify(capture),
      );
    db.sqlite
      .prepare("INSERT INTO dance_consents VALUES(?,?)")
      .run(captureId, JSON.stringify(consent));
    const lookup = retainedDanceAccount(db.asD1(), f.source);
    const args = [
      f.source.sourceHash,
      f.accountCommitment,
      f.capture.identityEpoch,
      f.capture.captureId,
      capture.captureHash,
    ] as const;
    assert.equal(await lookup(...args), null);
    db.sqlite
      .prepare(
        "INSERT INTO dance_reviews(review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json,state,local_denied) VALUES(?,?,?,?,?,'{}','{}','withdrawal_pending',1)",
      )
      .run(
        captureId,
        capture.communityId,
        f.accountId,
        "erased_media",
        word(2),
      );
    assert.deepEqual(await lookup(...args), {
      accountId: f.accountId,
      wallet: f.learner,
      accountCommitment: f.accountCommitment,
      identityEpoch: f.capture.identityEpoch,
    });
    await assert.rejects(
      lookup(args[0], args[1], args[2] + 1n, args[3], args[4]),
      /dance_historical_account_unverified/,
    );
    await assert.rejects(
      lookup(args[0], args[1], args[2], args[3], word(99)),
      /dance_historical_account_unverified/,
    );
    assert.equal(
      await lookup(word(99), args[1], args[2], args[3], args[4]),
      null,
    );
    assert.throws(
      () => db.sqlite.exec("UPDATE dance_consents SET consent_json='{}'"),
      /dance_consent_immutable/,
    );
  } finally {
    db.close();
  }
});

test("categorical release config is exact and identifies the real wire source", () => {
  const { source } = fixture();
  const json = {
    ...source,
    domain: { ...source.domain, chainId: 6343 },
    pin: {
      ...source.pin,
      deploymentBlock: source.pin.deploymentBlock.toString(),
    },
  };
  assert.deepEqual(
    selectedDanceRewardSource(JSON.stringify(json), hashJson(json)),
    source,
  );
  const wrong = { ...json, pin: { ...json.pin, termsSha256: word(999) } };
  assert.throws(
    () => selectedDanceRewardSource(JSON.stringify(wrong), hashJson(json)),
    /dance_reward_source_selection_changed/,
  );
  assert.throws(
    () => selectedDanceRewardSource(JSON.stringify(wrong), hashJson(wrong)),
    /dance_source_pin_changed/,
  );
  const main = { ...json, domain: { ...json.domain, chainId: 4326 } };
  assert.throws(
    () => selectedDanceRewardSource(JSON.stringify(main), hashJson(main)),
    /dance_wrong_chain/,
  );
});

test("local Dance outbox freezes the exact canonical capture, submission and verdict command", async () => {
  const f = fixture(),
    wire = f.capture,
    { domain, pin } = f.source;
  const captureId = wire.captureId.slice(2);
  const capture: LocalCapture = {
    version: "pirate.dance/1",
    captureId,
    communityId: domain.communityId,
    learner: {
      accountId: f.accountId,
      wallet: f.learner,
      active: true,
      identityEpoch: 1,
      groupId: wire.groupId,
      groupEpoch: 1,
      knownAliases: [f.accountId],
      authorizationId: wire.authorizationId,
      accountCommitment: wire.accountCommitment,
    },
    songKey: f.offer.songKey,
    songRevision: Number(wire.song.revision),
    songDurationSamples: 1440000,
    manifestSha256: wire.song.manifestSha256,
    audioSha256: wire.song.audioSha256,
    mediaPolicyVersion: "pirate.dance-private/1",
    mediaPolicyHash: pin.mediaPolicySha256,
    reference: null,
    startSample: Number(wire.referenceSelection.startSample),
    durationSamples: Number(wire.referenceSelection.durationSamples),
    policy: "moderator-review-policy-v2",
    rulesHash: pin.rulesSha256,
    termsHash: pin.termsSha256,
    rubricHash: pin.rubricSha256,
    rubricText: "Fixture rubric",
    offer: {
      offerId: f.offer.offerId,
      offerIdCommitment: wire.offer.offerIdCommitment,
      inputHash: f.inputHash,
      sourceHash: f.source.sourceHash,
      opensAtMs: f.offer.opensAt,
      cutoffAtMs: f.offer.cutoffAt,
    },
    source: {
      chainId: 6343,
      address: domain.verifier,
      runtimeCodeHash: pin.runtimeCodeHash,
      fromBlock: pin.deploymentBlock.toString(),
      communityId: domain.communityId,
      publisher: pin.fixedPublisher,
      policyHash: pin.publicityPolicyHash,
      sourceHash: f.source.sourceHash,
    },
    reservedAtMs: Number(wire.reservedAtMs),
    expiresAtMs: Number(ms + 10000n),
    captureHash: f.submission.captureHash,
    consent: {
      accepted: true,
      version: "fixture-consent",
      termsHash: pin.termsSha256,
      publicityPolicyHash: pin.publicityPolicyHash,
      receiptId: "fixture_consent_1",
      accountId: f.accountId,
      captureId,
      captureHash: f.submission.captureHash,
      acceptedAtMs: Number(f.consent.acceptedAtMs),
    },
    expected: {
      ownerEpoch: 1,
      configurationRevision: 2,
      rulesEpoch: 0,
      mediaEpoch: 0,
    },
  };
  const review: DanceReview = {
    version: capture.version,
    reviewId: captureId,
    revision: 1,
    capture,
    media: mediaBinding(capture, f.recordingSha256),
    receipt: {
      submissionId: captureId,
      communityId: domain.communityId,
      accountId: f.accountId,
      mediaId: "fixture-media-id",
      bindingCommitment: f.submission.mediaBindingHash,
      trustedSubmittedAtMs: Number(f.submission.trustedSubmittedAtMs),
      reviewDeadlineMs: Number(f.submission.reviewDeadlineMs),
      mediaRevision: 2,
    },
    state: "awaiting_review",
    localDenied: false,
    decision: null,
    canonical: null,
  };
  const payload = submissionIntentPreimage(review, "fixture_register_1");
  const outbox: DanceOutbox = {
    commandId: payload.commandId,
    communityId: domain.communityId,
    subjectId: captureId,
    kind: "submission",
    status: "held",
    payloadJson: JSON.stringify(payload),
    localIntegrityHash: hashJson(payload),
  };
  assert.deepEqual(
    canonicalDanceCapture(f.source, capture, wire.song.postId),
    wire,
  );
  const registered = canonicalDanceRegistration(
    f.source,
    review,
    wire.song.postId,
    outbox,
  );
  assert.deepEqual(registered.submission, f.submission);
  assert.equal(
    registered.submissionHash,
    danceSubmissionHash(domain, f.submission),
  );
  assert.equal(registered.command.encoded.length, 2 + 54 * 64);
  assert.throws(
    () => canonicalDanceRegistration(f.source, review, word(99), outbox),
    /dance_canonical_capture_changed/,
  );
  assert.throws(
    () =>
      canonicalDanceRegistration(f.source, review, wire.song.postId, {
        ...outbox,
        localIntegrityHash: word(99),
      }),
    /dance_outbox_conflict/,
  );

  const reviewerWallet = address(24),
    reviewerId = "fixture_reviewer";
  const account = danceAccountCommitment(domain, reviewerId, reviewerWallet);
  const decision = decisionIntent(
    review,
    "fixture_verdict_1",
    "pass",
    {
      accountId: reviewerId,
      wallet: reviewerWallet,
      identityEpoch: 1,
      groupId: danceSingletonId(domain, account),
      groupEpoch: 1,
      authorizationId: word(45),
      knownAliases: [reviewerId],
      authority: "owner:fixture",
      ownerEpoch: 1,
      roleEpoch: 1,
      accountCommitment: account,
      expectedConfigurationRevision: 2,
      expectedRulesEpoch: 0,
      expectedMediaEpoch: 1,
      consentVersion: "fixture-consent",
      publicityPolicyHash: pin.publicityPolicyHash,
      consentAccepted: true,
    },
    Number(ms - 1000n),
  );
  const committed = canonicalDanceDecision(f.source, decision);
  assert.equal(committed.submissionId, f.submission.submissionId);
  assert.equal(committed.command.encoded.length, 2 + 15 * 64);
  await assert.rejects(
    reconcileCanonicalDanceVerdict(f.rpc, f.source, decision, f.log),
    /dance_canonical_evidence_changed/,
  );
  f.log.topics[2] = committed.command.id;
  const words = f.log.data.slice(2).match(/.{64}/g)!;
  words[2] = committed.command.hash.slice(2);
  words[4] = account.slice(2);
  f.log.data = `0x${words.join("")}`;
  f.receipt.logs[0] = { ...f.log };
  const evidence = await reconcileCanonicalDanceVerdict(
    f.rpc,
    f.source,
    decision,
    f.log,
  );
  assert.equal(evidence.commandId, decision.commandId);
  assert.equal(evidence.submissionId, captureId);
  assert.equal(evidence.commandHash, committed.command.hash);
  assert.equal(evidence.submissionHash, registered.submissionHash);
  assert.equal(evidence.verdict, "pass");

  const journal = {
    attempts: async () => [f.receipt.transactionHash],
    prior: async () => null,
  };
  assert.deepEqual(
    await observeDanceIntent(f.rpc, f.source, journal, decision),
    evidence,
  );
  await assert.rejects(
    observeDanceIntent(
      f.rpc,
      f.source,
      { ...journal, attempts: async () => [word(999)] },
      decision,
    ),
    /dance_receipt_not_owned/,
  );
  assert.equal(
    await observeDanceIntent(
      f.rpc,
      f.source,
      {
        attempts: async () => [],
        prior: async () => evidence,
      },
      decision,
    ),
    null,
  );
  f.eventBlock.hash = word(998);
  const orphanedJournal = {
    attempts: async () => [],
    prior: async () => evidence,
  };
  await assert.rejects(
    observeDanceIntent(
      {
        ...f.rpc,
        block: async (number) =>
          number === f.safe.number
            ? { ...f.safe, hash: word(997) }
            : f.rpc.block(number),
      },
      f.source,
      orphanedJournal,
      decision,
    ),
    /dance_observation_anchor_changed/,
  );
  assert.deepEqual(
    await observeDanceIntent(
      f.rpc,
      f.source,
      {
        attempts: async () => [],
        prior: async () => evidence,
      },
      decision,
    ),
    { ...evidence, canonical: false },
  );
});
