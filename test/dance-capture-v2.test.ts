import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { hashJson } from "../packages/community/common.ts";
import {
  parseDanceCaptureV2,
  parseStoredDanceCapture,
  hashPrivateDanceCaptureV2,
  parseCaptureRequestV2,
} from "../packages/dance/capture-v2.ts";
import { validateCapture } from "../packages/dance/validation.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import { danceCaptureHash } from "../packages/dance-chain/v2/wire.ts";
import { danceCaptureV2Fixture, word } from "./fixtures/dance-capture-v2.ts";

test("bound V2 parses actual ABI/hash/original grant without a V4 authority field", () => {
  const f = danceCaptureV2Fixture();
  f.bound.consent = f.receipt(f.bound);
  const parsed = parseDanceCaptureV2(f.bound);
  assert.equal(parsed.publication.kind, "publication-bound");
  assert.equal(parsed.captureId, f.wire.captureId);
  assert.equal(parsed.captureHash, danceCaptureHash(f.domain, f.wire));
  assert.equal(Object.hasOwn(parsed.learner, "authorizationId"), false);
  assert.equal(Object.hasOwn(parsed, "source"), false);
  assert.deepEqual(parsed, f.bound);
  assert.ok(
    Object.isFrozen(parsed) &&
      Object.isFrozen(parsed.learner) &&
      Object.isFrozen(parsed.expected),
  );
  if (parsed.publication.kind === "publication-bound") {
    assert.ok(Object.isFrozen(parsed.publication.binding.grant));
    f.bound.publication.binding.grant.permissionRevision = "3";
    assert.equal(parsed.publication.binding.grant.permissionRevision, "2");
  }
});

test("private V2 uses the independent domain-separated snapshot and never constructs publication bytes", () => {
  const f = danceCaptureV2Fixture();
  assert.equal(
    hashPrivateDanceCaptureV2(f.privateSnapshot),
    f.privateCapture.captureHash,
  );
  assert.notEqual(f.privateCapture.captureHash, f.bound.captureHash);
  assert.equal(
    hashPrivateDanceCaptureV2(f.privateCapture),
    f.privateCapture.captureHash,
  );
  const parsed = parseDanceCaptureV2(f.privateCapture, false);
  assert.deepEqual(parsed, f.privateCapture);
  assert.equal(parsed.canonical, null);
  assert.ok(Object.isFrozen(parsed.publication));
  f.privateCapture.consent = f.receipt(f.privateCapture);
  assert.equal(hashPrivateDanceCaptureV2(f.privateCapture), parsed.captureHash);
  assert.deepEqual(parseDanceCaptureV2(f.privateCapture), f.privateCapture);
});

test("reservation without media consent is explicit; a publication grant never substitutes for media consent", () => {
  const f = danceCaptureV2Fixture();
  for (const capture of [f.bound, f.privateCapture]) {
    assert.throws(() => parseDanceCaptureV2(capture), /dance_consent_required/);
    assert.equal(parseDanceCaptureV2(capture, false).consent, null);
  }
});

for (const kind of [
  "private grant",
  "private ABI",
  "legacy authority",
  "extra field",
  "extra learner",
  "extra expected",
  "wrong version",
  "UUID ID",
  "zero ID",
  "trailing ID",
  "bad hash",
] as const)
  test(`closed private schema rejects ${kind}`, () => {
    const f = danceCaptureV2Fixture(),
      c = f.privateCapture;
    const value: unknown =
      kind === "private grant"
        ? { ...c, publication: f.bound.publication }
        : kind === "private ABI"
          ? { ...c, canonical: f.bound.canonical }
          : kind === "legacy authority"
            ? { ...c, source: f.legacy.source }
            : kind === "extra field"
              ? { ...c, ignored: true }
              : kind === "extra learner"
                ? {
                    ...c,
                    learner: {
                      ...c.learner,
                      authorizationId: f.bound.publication.binding.grantId,
                    },
                  }
                : kind === "extra expected"
                  ? { ...c, expected: { ...c.expected, ownerEpoch: 7 } }
                  : kind === "wrong version"
                    ? { ...c, version: "pirate.dance/3" }
                    : kind === "UUID ID"
                      ? {
                          ...c,
                          captureId: "11111111-1111-4111-8111-111111111111",
                        }
                      : kind === "zero ID"
                        ? { ...c, captureId: word(0) }
                        : kind === "trailing ID"
                          ? { ...c, captureId: c.captureId + "\n" }
                          : { ...c, captureHash: word(999) };
    assert.throws(() => parseDanceCaptureV2(value, false));
  });

for (const kind of [
  "source hash",
  "pin trailing bytes",
  "capture trailing bytes",
  "capture hash",
  "capture ID",
  "account commitment",
  "song key",
  "song revision",
  "audio",
  "rules",
  "reference",
  "offer",
  "bound time",
] as const)
  test(`bound canonical DTO rejects independent ${kind} mismatch`, () => {
    const f = danceCaptureV2Fixture();
    if (kind === "source hash") f.bound.canonical.sourceHash = word(999);
    if (kind === "pin trailing bytes")
      f.bound.canonical.sourcePinAbi = `${f.bound.canonical.sourcePinAbi}${"00".repeat(32)}`;
    if (kind === "capture trailing bytes")
      f.bound.canonical.captureAbi = `${f.bound.canonical.captureAbi}${"00".repeat(32)}`;
    if (kind === "capture hash") f.bound.captureHash = word(999);
    if (kind === "capture ID") {
      f.wire.captureId = word(999);
      f.refresh();
    }
    if (kind === "account commitment") {
      f.wire.accountCommitment = word(999);
      f.refresh();
    }
    if (kind === "song key") f.bound.songKey = word(999);
    if (kind === "song revision") {
      f.wire.song.revision++;
      f.refresh();
    }
    if (kind === "audio") {
      f.wire.song.audioSha256 = word(999);
      f.refresh();
    }
    if (kind === "rules") {
      f.wire.rulesSha256 = word(999);
      f.refresh();
    }
    if (kind === "reference") {
      f.wire.referenceSelection.epoch++;
      f.refresh();
    }
    if (kind === "offer") {
      f.wire.offer.inputHash = word(999);
      f.refresh();
    }
    if (kind === "bound time") {
      f.wire.reservedAtMs++;
      f.refresh();
    }
    assert.throws(() => parseDanceCaptureV2(f.bound, false));
  });

for (const kind of [
  "purpose",
  "target",
  "policy",
  "grant digest",
  "registry",
  "registry code",
  "directory",
  "community",
  "grant wallet",
  "binding seconds",
  "recording after binding",
  "generation",
  "configuration decimal",
  "owner zero",
  "resource decimal",
] as const)
  test(`original publication binding rejects ${kind}`, () => {
    const f = danceCaptureV2Fixture(),
      b = f.bound.publication.binding;
    if (kind === "purpose") {
      b.grant.purpose = "study-results";
      f.rebind();
    }
    if (kind === "target") {
      b.grant.publicationTarget = f.pin.posts;
      f.rebind();
    }
    if (kind === "policy") {
      b.grant.policyHash = word(999);
      f.rebind();
    }
    if (kind === "grant digest") b.grantId = word(999);
    if (kind === "registry") b.source.registry = f.pin.posts;
    if (kind === "registry code") b.source.registryRuntimeHash = word(999);
    if (kind === "directory") b.source.directory = f.pin.posts;
    if (kind === "community") b.source.communityId = word(999);
    if (kind === "grant wallet") {
      b.grant.learner = f.pin.posts;
      f.rebind();
    }
    if (kind === "binding seconds")
      b.boundAtS = String(BigInt(b.boundAtS) + 1n);
    if (kind === "recording after binding")
      b.recordedAtS = String(BigInt(b.boundAtS) + 1n);
    if (kind === "generation") b.localFenceGeneration = "01";
    if (kind === "configuration decimal")
      f.bound.expected.configurationRevision = "01";
    if (kind === "owner zero") f.bound.expected.ownerEpoch = "0";
    if (kind === "resource decimal") f.bound.expected.mediaEpoch = "-1";
    assert.throws(() => parseDanceCaptureV2(f.bound, false));
  });

for (const kind of [
  "before reservation",
  "at expiry",
  "wrong account",
  "wrong capture",
  "wrong hash",
  "wrong terms",
  "wrong publicity",
  "extra receipt",
] as const)
  test(`separate media consent rejects ${kind}`, () => {
    const f = danceCaptureV2Fixture();
    const receipt = f.receipt(f.bound);
    if (kind === "before reservation")
      receipt.acceptedAtMs = f.bound.reservedAtMs - 1;
    if (kind === "at expiry") receipt.acceptedAtMs = f.bound.expiresAtMs;
    if (kind === "wrong account") receipt.accountId = "foreign_private_account";
    if (kind === "wrong capture") receipt.captureId = word(999);
    if (kind === "wrong hash") receipt.captureHash = word(999);
    if (kind === "wrong terms") receipt.termsHash = word(999);
    if (kind === "wrong publicity") receipt.publicityPolicyHash = word(999);
    f.bound.consent = receipt;
    assert.throws(() =>
      parseDanceCaptureV2(
        kind === "extra receipt"
          ? {
              ...f.bound,
              consent: { ...receipt, ignored: true },
            }
          : f.bound,
      ),
    );
  });

test("consent accepts inclusive reservation and last valid millisecond, without changing capture identity", () => {
  const f = danceCaptureV2Fixture();
  for (const capture of [f.bound, f.privateCapture]) {
    for (const acceptedAtMs of [
      capture.reservedAtMs,
      capture.expiresAtMs - 1,
    ]) {
      const receipt = { ...f.receipt(capture), acceptedAtMs };
      const parsed = parseDanceCaptureV2({ ...capture, consent: receipt });
      assert.equal(parsed.captureHash, capture.captureHash);
    }
  }
});

test("all resource fields belong to the private snapshot, while a late grant cannot upgrade its stored mode", () => {
  const f = danceCaptureV2Fixture();
  const changed = {
    ...f.privateCapture,
    expected: { ...f.privateCapture.expected, mediaEpoch: 1 },
  };
  assert.throws(() => parseDanceCaptureV2(changed, false));
  const { captureHash: _hash, consent: _receipt, ...snapshot } = changed;
  const rehashed = {
    ...changed,
    captureHash: hashJson({
      schema: "pirate.dance-private-capture/2",
      capture: snapshot,
    }),
  };
  assert.equal(parseDanceCaptureV2(rehashed, false).canonical, null);
  assert.throws(() =>
    parseDanceCaptureV2(
      { ...f.privateCapture, publication: f.bound.publication },
      false,
    ),
  );
});

test("bound decimal epochs preserve uint64 precision without using grant revision as configuration revision", () => {
  const f = danceCaptureV2Fixture();
  f.bound.expected.ownerEpoch = "18446744073709551615";
  const parsed = parseDanceCaptureV2(f.bound, false);
  assert.ok("ownerEpoch" in parsed.expected);
  assert.equal(parsed.expected.ownerEpoch, "18446744073709551615");
  assert.equal(f.bound.publication.binding.grant.permissionRevision, "2");
  assert.equal(parsed.expected.configurationRevision, "99");
});

test("wire absence is canonical: null reference/offer requires all corresponding zero fields", () => {
  const f = danceCaptureV2Fixture();
  const bound = { ...f.bound, reference: null, offer: null };
  f.wire.referenceSelection = {
    ...f.wire.referenceSelection,
    present: false,
    id: word(0),
    revision: 0n,
    epoch: 0n,
    segmentLayoutSha256: word(0),
    segmentId: word(0),
  };
  f.wire.offer = {
    present: false,
    offerIdCommitment: word(0),
    inputHash: word(0),
    sourceHash: word(0),
    opensAtMs: 0n,
    cutoffAtMs: 0n,
  };
  bound.canonical.captureAbi = encodeAbiParameters(
    [danceShapes.capture],
    [f.wire],
  );
  bound.captureHash = danceCaptureHash(f.domain, f.wire);
  assert.equal(parseDanceCaptureV2(bound, false).offer, null);
  f.wire.referenceSelection.id = word(999);
  bound.canonical.captureAbi = encodeAbiParameters(
    [danceShapes.capture],
    [f.wire],
  );
  bound.captureHash = danceCaptureHash(f.domain, f.wire);
  assert.throws(() => parseDanceCaptureV2(bound, false));
});

test("V1 dispatch delegates unchanged legacy validation without inventing V2 authority", () => {
  const f = danceCaptureV2Fixture();
  validateCapture(f.legacy, false);
  assert.deepEqual(parseStoredDanceCapture(f.legacy, false), f.legacy);
  assert.throws(
    () => parseStoredDanceCapture(f.legacy),
    /dance_consent_required/,
  );
  assert.deepEqual(
    parseStoredDanceCapture(f.privateCapture, false),
    f.privateCapture,
  );
  assert.throws(() =>
    parseStoredDanceCapture(
      { ...f.bound, version: "pirate.dance/unknown" },
      false,
    ),
  );
});

test("new requests are closed DTOs, preserve the durable Dance command, and do not bind consent or allocate captures", () => {
  const f = danceCaptureV2Fixture();
  const request = {
    version: "pirate.dance-capture-request/2",
    commandId: "dance_command_01",
    target: {
      communityId: f.bound.communityId,
      songKey: f.bound.songKey,
      songRevision: f.bound.songRevision,
      audioSha256: f.bound.audioSha256,
      reference: {
        id: f.bound.reference.id,
        revision: f.bound.reference.revision,
      },
      offerId: f.bound.offer.offerId,
    },
    publication: { kind: "private" },
    consent: {
      accepted: true,
      version: "dance-consent-fixture/2",
      termsHash: f.bound.termsHash,
      publicityPolicyHash: f.pin.publicityPolicyHash,
    },
  };
  assert.deepEqual(parseCaptureRequestV2(request), request);
  for (const value of [
    { ...request, ignored: true },
    { ...request, captureId: f.bound.captureId },
    {
      ...request,
      publication: { kind: "private", publicationCommandId: word(999) },
    },
    { ...request, target: { ...request.target, authorizationId: word(999) } },
  ])
    assert.throws(() => parseCaptureRequestV2(value));
  const bound = {
    ...request,
    publication: {
      kind: "publication-bound",
      publicationCommandId: f.bound.publication.publicationCommandId,
    },
  };
  assert.deepEqual(parseCaptureRequestV2(bound), bound);
});
