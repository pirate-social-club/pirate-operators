import { defaultContentProfile } from "../packages/moderation/content-profile.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashText, publicId } from "../packages/community/common.ts";
import {
  readMp3FrameWindow,
  readMp3Probe,
} from "../packages/moderation/mp3-windows.ts";
import {
  evidenceDomain,
  evidenceTypes,
  evidenceSchemas,
  signEvidence,
  evidenceId,
  type EvidenceCheck,
  type EvidenceRecord,
} from "../packages/moderation/evidence.ts";
import {
  verifyAdmission,
  type AdmissionFacts,
} from "../packages/moderation/admission.ts";

// Public local fixture keys only; never used by a live runtime or funded.
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`),
  other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const facts: AdmissionFacts = {
  communityId: publicId(),
  submissionId: "submission-fixture",
  jobId: "job-fixture",
  songSha256: hashText("song-fixture"),
  songByteLength: 1000,
  title: "A title",
  lyrics: "Explicit lyrics fixture",
  songType: "original",
  declaredRating: "general",
  windows: [
    {
      role: "primary",
      firstFrame: 10,
      frameCount: 460,
      startMs: 261,
      durationMs: 12016,
      sampleSha256: hashText("sample-fixture"),
    },
  ],
  providerEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
};
const policy = {
  contentProfile: defaultContentProfile,
  recognitionOperators: [signer.address],
  contentOperators: [signer.address],
  maxAgeSeconds: 3600,
};
async function record(
  check: EvidenceCheck,
  result = check === "audio.identification" ? "not_identified" : "general",
  key = signer,
) {
  const inputs =
    check === "audio.identification"
      ? {
          songSha256: facts.songSha256,
          songByteLength: facts.songByteLength,
          extraction: "mp3-frame-window/1",
          windows: facts.windows.map((w) => ({
            ...w,
            providerCode: result === "identified" ? 0 : 1001,
          })),
          provider: "acrcloud",
          providerEndpoint: facts.providerEndpoint,
        }
      : check === "title.rating"
        ? { titleRevision: 1, titleSha256: hashText(facts.title) }
        : { lyricsRevision: 1, lyricsSha256: hashText(facts.lyrics) };
  const details =
    check === "lyrics.classification"
      ? {
          profile: defaultContentProfile,
          explicit: true,
          primaryLanguage: "en",
        }
      : { profile: defaultContentProfile, providerReceipt: "fixture" };
  return signEvidence(
    key,
    {
      check,
      schema: evidenceSchemas[check],
      submissionId: facts.submissionId,
      communityId: facts.communityId,
      jobId: facts.jobId,
      subject:
        check === "audio.identification"
          ? facts.songSha256
          : hashText(check === "title.rating" ? facts.title : facts.lyrics),
      evaluator: "fixture-evaluator/1",
      policy: "pirate-release/2026-08-29",
      result,
      issuedAt: 1000,
      expiresAt: 4600,
    },
    inputs,
    details,
  );
}
const records = () =>
  Promise.all([
    record("audio.identification"),
    record("title.rating"),
    record("lyrics.classification"),
  ]);

test("the current EIP712 release gate allows explicit lyrics and enforces rejection and holds", async () => {
  const values = await records();
  assert.deepEqual(evidenceDomain, { name: "Pirate Operators", version: "2" });
  const admitted = await verifyAdmission(facts, values, policy, 1001);
  assert.equal(admitted.decision, "publish");
  assert.equal(admitted.used.length, 3);
  const adult = await verifyAdmission(
    facts,
    [values[0], values[1], await record("lyrics.classification", "adult_18")],
    policy,
    1001,
  );
  assert.equal(adult.decision, "publish");
  assert.equal(adult.rating, "adult_18");
  assert.equal(
    (
      await verifyAdmission(
        facts,
        [
          await record("audio.identification", "identified"),
          ...values.slice(1),
        ],
        policy,
        1001,
      )
    ).decision,
    "block",
  );
  assert.equal(
    (
      await verifyAdmission(
        { ...facts, songType: "other" },
        values,
        policy,
        1001,
      )
    ).decision,
    "hold",
  );
  const alternateFacts = {
    ...facts,
    windows: [
      facts.windows[0]!,
      { ...facts.windows[0]!, role: "alternate" as const, firstFrame: 1000 },
    ],
  };
  const inconclusive = await signEvidence(
    signer,
    { ...values[0]!.envelope, result: "inconclusive" },
    {
      ...values[0]!.inputs,
      windows: alternateFacts.windows.map((w) => ({
        ...w,
        providerCode: 2004,
      })),
    },
    values[0]!.details,
  );
  assert.equal(
    (
      await verifyAdmission(
        alternateFacts,
        [inconclusive, ...values.slice(1)],
        policy,
        1001,
      )
    ).decision,
    "hold",
  );
});

test("changed input, scope, signer, policy, expiry or restricted details cannot satisfy a check", async () => {
  const values = await records(),
    original = values[0]!;
  const clone = () => structuredClone(original);
  const corrupted: EvidenceRecord[] = [];
  let changed = clone();
  changed.details.providerReceipt = "changed";
  corrupted.push(changed);
  changed = clone();
  changed.envelope.policy = "different-release";
  corrupted.push(changed);
  changed = clone();
  changed.envelope.communityId = publicId();
  corrupted.push(changed);
  changed = clone();
  changed.envelope.submissionId = "another-submission";
  corrupted.push(changed);
  changed = clone();
  changed.inputs.songByteLength = 999;
  corrupted.push(changed);
  changed = clone();
  changed.signature = await signer.signTypedData({
    domain: { ...evidenceDomain, chainId: 6343 },
    types: evidenceTypes,
    primaryType: "Evidence",
    message: { ...changed.envelope, issuedAt: 1000n, expiresAt: 4600n },
  });
  corrupted.push(changed);
  corrupted.push(await record("audio.identification", "not_identified", other));
  for (const invalid of corrupted)
    assert.equal(
      (
        await verifyAdmission(
          facts,
          [invalid, ...values.slice(1)],
          policy,
          1001,
        )
      ).decision,
      "needs_evidence",
    );
  assert.equal(
    (
      await verifyAdmission(
        { ...facts, title: "Changed" },
        values,
        policy,
        1001,
      )
    ).decision,
    "needs_evidence",
  );
  assert.equal(
    (await verifyAdmission(facts, values, policy, 4600)).decision,
    "needs_evidence",
  );
  assert.equal(
    (
      await verifyAdmission(
        facts,
        values,
        { ...policy, maxAgeSeconds: 10 },
        1011,
      )
    ).decision,
    "needs_evidence",
  );
  assert.equal(
    (await verifyAdmission(facts, values, policy, 999)).decision,
    "needs_evidence",
  );
  assert.notEqual(
    evidenceId(original.envelope),
    evidenceId({ ...original.envelope, communityId: publicId() }),
  );
});

test("independently signed changed audio windows fail binding and trusted disagreement holds", async () => {
  const values = await records();
  const changed = await signEvidence(
    signer,
    values[0]!.envelope,
    {
      ...values[0]!.inputs,
      windows: [{ ...facts.windows[0], firstFrame: 11, providerCode: 1001 }],
    },
    values[0]!.details,
  );
  assert.equal(
    (await verifyAdmission(facts, [changed, ...values.slice(1)], policy, 1001))
      .decision,
    "needs_evidence",
  );
  const disagree = await record("title.rating", "adult_18", other);
  assert.equal(
    (
      await verifyAdmission(
        facts,
        [...values, disagree],
        {
          ...policy,
          contentProfile: defaultContentProfile,
          recognitionOperators: [signer.address, other.address],
          contentOperators: [signer.address, other.address],
        },
        1001,
      )
    ).decision,
    "hold",
  );
});

function mp3(frames: number) {
  const bytes = new Uint8Array(frames * 417);
  for (let i = 0; i < frames; i++) {
    bytes.set([0xff, 0xfb, 0x90, 0], i * 417);
    new DataView(bytes.buffer).setUint32(i * 417 + 4, i);
  }
  return bytes;
}
function stream(bytes: Uint8Array, chunk = 997) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset = Math.min(bytes.length, offset + chunk);
    },
  });
}
test("raw MP3 windows preserve complete source frames and reproducible occurrence metadata", async () => {
  const bytes = mp3(1600),
    signal = new AbortController().signal;
  const probe = await readMp3Probe(stream(bytes), 3600000, signal);
  assert.equal(probe.durationMs, Math.round((1600 * 1152 * 1000) / 44100));
  for (const [role, fraction] of [
    ["primary", 0.25],
    ["alternate", 0.75],
  ] as const) {
    const window = await readMp3FrameWindow(
      stream(bytes, 1003),
      probe.durationMs,
      role,
      4000000,
      signal,
    );
    const first = Math.floor(
      Math.floor((probe.durationMs - 12000) * fraction) /
        ((1152 * 1000) / 44100),
    );
    assert.equal(window.firstFrame, first);
    assert.equal(window.frameCount, 460);
    assert.deepEqual(
      window.bytes,
      bytes.slice(first * 417, (first + 460) * 417),
    );
    assert.equal(
      sha256(window.bytes),
      sha256(bytes.slice(first * 417, (first + 460) * 417)),
    );
  }
  const short = mp3(22),
    shortProbe = await readMp3Probe(stream(short), 3600000, signal);
  assert.deepEqual(
    (
      await readMp3FrameWindow(
        stream(short),
        shortProbe.durationMs,
        "primary",
        4000000,
        signal,
      )
    ).bytes,
    short,
  );
  await assert.rejects(
    readMp3Probe(stream(bytes.slice(0, -1)), 3600000, signal),
    /inconsistent_media_facts/,
  );
  await assert.rejects(
    readMp3Probe(stream(bytes), 1000, signal),
    /duration_exceeded/,
  );
  await assert.rejects(
    readMp3FrameWindow(stream(bytes), probe.durationMs, "primary", 100, signal),
    /output_too_large/,
  );
});

test("each check trusts only its configured signer and rejects the v1 signature domain", async () => {
  const split = {
    contentProfile: defaultContentProfile,
    recognitionOperators: [signer.address],
    contentOperators: [other.address],
    maxAgeSeconds: 3600,
  };
  const values = await Promise.all([
    record("audio.identification"),
    record("title.rating", "general", other),
    record("lyrics.classification", "general", other),
  ]);
  assert.equal(
    (await verifyAdmission(facts, values, split, 1001)).decision,
    "publish",
  );
  const forged = await record("audio.identification", "not_identified", other);
  assert.equal(
    (await verifyAdmission(facts, [forged, ...values.slice(1)], split, 1001))
      .decision,
    "needs_evidence",
  );
  const old = {
    ...values[0],
    signature: await signer.signTypedData({
      domain: { name: "Pirate Operators", version: "1" },
      types: evidenceTypes,
      primaryType: "Evidence",
      message: { ...values[0]!.envelope, issuedAt: 1000n, expiresAt: 4600n },
    }),
  };
  assert.equal(
    (await verifyAdmission(facts, [old, ...values.slice(1)], split, 1001))
      .decision,
    "needs_evidence",
  );
});
