/** Pure selected DTO validation. No ID allocation, authentication, current
 * permission check, original-command reconciliation, storage or publication.
 * Root must authenticate these retained facts and fence the original command,
 * selected source and owner/configuration/resource epochs in its accepting batch. */
import {
  decodeAbiParameters, encodeAbiParameters, hashTypedData, keccak256, stringToHex,
  zeroHash, type Hex,
} from "viem";
import { CommunityError, exact, hashJson, insist, integer, object, text } from "../community/common.ts";
import { danceShapes } from "../dance-chain/v2/wire-shapes.ts";
import { danceAccountCommitment, danceCaptureHash, danceOfferId, danceSourceHash } from "../dance-chain/v2/wire.ts";
import { songKeyOf } from "../protocol/records.ts";
import { consentAddress, consentDigest, consentUint64, parsePublicationGrant, publicationDomain } from "../protocol/publication-consent.ts";
import { publicationConsentTypes } from "../protocol/generated/publication-consent-v1.ts";
import type { BoundPublicationGrantV1 } from "../protocol/publication-runtime-v1.ts";
import { rewardId } from "../rewards/validation.ts";
import { DANCE_PRIVATE_MEDIA_POLICY, DANCE_VERSION, type DanceCapture, type DanceConsentAcceptance, type DanceConsentReceipt } from "./contracts.ts";
import type { DanceProductionTarget } from "./production.ts";
import { validateCapture } from "./validation.ts";

type CaptureFieldsV2 = Readonly<Omit<DanceCapture,
  "version" | "captureId" | "learner" | "source" | "expected" | "captureHash" | "consent"
> & {
  version: "pirate.dance/2"; captureId: Hex;
  learner: Readonly<{ accountId: string; wallet: Hex }>;
  captureHash: Hex; consent: DanceConsentReceipt | null;
}>;
export type PrivateCaptureV2 = CaptureFieldsV2 & Readonly<{
  publication: { readonly kind: "private" }; canonical: null;
  expected: Readonly<{ configurationRevision: number; rulesEpoch: number; mediaEpoch: number }>;
}>;
export type PublicationCaptureV2 = CaptureFieldsV2 & Readonly<{
  publication: Readonly<{ kind: "publication-bound"; publicationCommandId: Hex; binding: BoundPublicationGrantV1 }>;
  canonical: Readonly<{ encoding: "pirate.dance-capture-abi/2";
    domain: Readonly<{ chainId: string; verifier: Hex; communityId: Hex }>;
    sourceHash: Hex; sourcePinAbi: Hex; captureAbi: Hex }>;
  expected: Readonly<{ ownerEpoch: string; configurationRevision: string; rulesEpoch: string; mediaEpoch: string }>;
}>;
export type DanceCaptureV2 = PrivateCaptureV2 | PublicationCaptureV2;
export type StoredDanceCapture = DanceCapture | DanceCaptureV2;
export type CaptureRequestV2 = Readonly<{
  version: "pirate.dance-capture-request/2"; commandId: string; target: DanceProductionTarget;
  publication: { readonly kind: "private" } | Readonly<{ kind: "publication-bound"; publicationCommandId: Hex }>;
  consent: DanceConsentAcceptance;
}>;
export type PrivateCaptureSnapshotV2 = Omit<PrivateCaptureV2, "captureHash" | "consent">;

const snapshotKeys = ["version", "captureId", "communityId", "learner", "songKey", "songRevision",
  "songDurationSamples", "manifestSha256", "audioSha256", "mediaPolicyVersion", "mediaPolicyHash",
  "reference", "startSample", "durationSamples", "policy", "rulesHash", "termsHash", "rubricHash",
  "rubricText", "offer", "reservedAtMs", "expiresAtMs", "expected", "publication", "canonical"];
const captureKeys = [...snapshotKeys, "captureHash", "consent"];
const uint = (v: unknown, min = 0) => integer(v, min, Number.MAX_SAFE_INTEGER);
const id = (v: unknown) => {
  insist(typeof v === "string" && /^[a-zA-Z0-9_:-]{1,128}(?![\s\S])/.test(v), "dance_invalid_id");
  return v;
};
const label = (v: unknown) => {
  const s = text(v, 128); insist(s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s), "dance_v2_label_invalid"); return s;
};
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function fields(c: Record<string, unknown>) {
  insist(c.version === "pirate.dance/2" && c.policy === "moderator-review-policy-v2" &&
    c.mediaPolicyVersion === DANCE_PRIVATE_MEDIA_POLICY.version, "dance_policy_mismatch");
  [c.captureId, c.communityId, c.songKey, c.manifestSha256, c.audioSha256,
    c.mediaPolicyHash, c.rulesHash, c.termsHash, c.rubricHash].forEach(v => consentDigest(v));
  const learner = object(c.learner); exact(learner, ["accountId", "wallet"]);
  id(learner.accountId); consentAddress(learner.wallet);
  uint(c.songRevision, 1); const samples = uint(c.songDurationSamples, 1);
  const start = uint(c.startSample), duration = integer(c.durationSamples, 288000, 1440000);
  insist(Number.isSafeInteger(start + duration) && start + duration <= samples, "dance_interval_invalid");
  insist(text(c.rubricText, 65536).length > 0, "dance_rubric_invalid");
  const reserved = uint(c.reservedAtMs, 1), expiry = uint(c.expiresAtMs, 1);
  insist(reserved < expiry, "dance_capture_expired", 410);
  if (c.reference !== null) {
    const r = object(c.reference); exact(r, ["id", "revision", "epoch", "segmentId", "segmentLayoutSha256"]);
    id(r.id); id(r.segmentId); consentDigest(r.segmentLayoutSha256); uint(r.revision, 1); uint(r.epoch, 1);
  }
  if (c.offer !== null) {
    const o = object(c.offer); exact(o, ["offerId", "offerIdCommitment", "inputHash", "sourceHash", "opensAtMs", "cutoffAtMs"]);
    rewardId(id(o.offerId)); [o.offerIdCommitment, o.inputHash, o.sourceHash].forEach(v => consentDigest(v));
    insist(uint(o.opensAtMs, 1) < uint(o.cutoffAtMs, 1), "dance_offer_binding_mismatch");
  }
}
function privateFields(c: Record<string, unknown>) {
  const p = object(c.publication); exact(p, ["kind"]);
  insist(p.kind === "private" && c.canonical === null, "dance_v2_private_publication_forbidden");
  const e = object(c.expected); exact(e, ["configurationRevision", "rulesEpoch", "mediaEpoch"]);
  uint(e.configurationRevision, 1); uint(e.rulesEpoch); uint(e.mediaEpoch);
}

/** Integrity only, never reward eligibility. Hash the exact private reservation
 * snapshot, excluding its self-hash and later, separately accepted media receipt.
 * Accept either that snapshot or a full private DTO; reject every other field. */
export function hashPrivateDanceCaptureV2(value: PrivateCaptureSnapshotV2 | PrivateCaptureV2): Hex {
  const c = object(value);
  exact(c, Object.hasOwn(c, "captureHash") || Object.hasOwn(c, "consent") ? captureKeys : snapshotKeys);
  fields(c); privateFields(c);
  const snapshot = Object.fromEntries(snapshotKeys.map(key => [key, c[key]]));
  return hashJson({ schema: "pirate.dance-private-capture/2", capture: snapshot });
}

function abi(value: unknown): Hex {
  insist(typeof value === "string" && value.length <= 65536 && /^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(value),
    "dance_v2_canonical_encoding_invalid"); return value as Hex;
}
function decode(c: PublicationCaptureV2) {
  const canonical = object(c.canonical);
  exact(canonical, ["encoding", "domain", "sourceHash", "sourcePinAbi", "captureAbi"]);
  insist(canonical.encoding === "pirate.dance-capture-abi/2", "dance_v2_canonical_encoding_invalid");
  const d = object(canonical.domain); exact(d, ["chainId", "verifier", "communityId"]);
  const chainId = consentUint64(d.chainId);
  insist(chainId === 6343n || chainId === 31337n, "unsupported_consent_chain");
  const domain = { chainId, verifier: consentAddress(d.verifier), communityId: consentDigest(d.communityId) };
  consentDigest(canonical.sourceHash);
  const pinAbi = abi(canonical.sourcePinAbi), captureAbi = abi(canonical.captureAbi);
  try {
    const [pin] = decodeAbiParameters([danceShapes.sourcePin], pinAbi);
    const [wire] = decodeAbiParameters([danceShapes.capture], captureAbi);
    insist(encodeAbiParameters([danceShapes.sourcePin], [pin]) === pinAbi &&
      encodeAbiParameters([danceShapes.capture], [wire]) === captureAbi, "dance_v2_canonical_encoding_invalid");
    return { domain, pin, wire };
  } catch { throw new CommunityError("dance_v2_canonical_encoding_invalid"); }
}

function publication(c: PublicationCaptureV2) {
  const p = object(c.publication); exact(p, ["kind", "publicationCommandId", "binding"]);
  insist(p.kind === "publication-bound", "dance_v2_publication_invalid"); consentDigest(p.publicationCommandId);
  const expected = object(c.expected); exact(expected, ["ownerEpoch", "configurationRevision", "rulesEpoch", "mediaEpoch"]);
  // These are retained caller-fenced epochs, not the grant's permissionRevision.
  // Neither owner nor configuration epoch is encoded in the V2 capture tuple.
  insist(consentUint64(expected.ownerEpoch) > 0n && consentUint64(expected.configurationRevision) > 0n,
    "dance_v2_expected_invalid");
  consentUint64(expected.rulesEpoch); consentUint64(expected.mediaEpoch);
  const { domain, pin, wire } = decode(c);
  [pin.directory, pin.consentRegistry, pin.posts].forEach(a => consentAddress(a.toLowerCase()));
  [pin.directoryRuntimeHash, pin.consentRegistryRuntimeHash, pin.postsRuntimeHash, pin.runtimeCodeHash,
    pin.executionRule, pin.learnerConsentPolicyHash, pin.reviewerConsentPolicyHash, pin.publicityPolicyHash,
    pin.rulesSha256, pin.termsSha256, pin.rubricSha256, pin.mediaPolicySha256].forEach(v => consentDigest(v));
  insist(pin.executionRule === keccak256(stringToHex("directory-current-publisher/1")) &&
    domain.communityId === c.communityId && danceSourceHash(domain, pin) === c.canonical.sourceHash &&
    danceCaptureHash(domain, wire) === c.captureHash, "dance_v2_canonical_hash_mismatch");
  insist(wire.captureId === c.captureId && wire.learner.toLowerCase() === c.learner.wallet &&
    wire.accountCommitment === danceAccountCommitment(domain, c.learner.accountId, consentAddress(c.learner.wallet)) &&
    wire.identityEpoch > 0n && wire.groupEpoch > 0n && wire.reservedAtMs === BigInt(c.reservedAtMs),
    "dance_v2_capture_binding_mismatch");
  consentDigest(wire.groupId); consentDigest(wire.publicationGrantId);
  const song = wire.song;
  consentDigest(song.postId);
  insist(song.chainId === domain.chainId && song.posts.toLowerCase() === pin.posts.toLowerCase() &&
    song.communityId === domain.communityId && song.revision === BigInt(c.songRevision) &&
    song.manifestSha256 === c.manifestSha256 && song.audioSha256 === c.audioSha256 &&
    songKeyOf({ ...song, chainId: Number(domain.chainId) }) === c.songKey,
    "dance_v2_song_binding_mismatch");
  insist(wire.rulesSha256 === pin.rulesSha256 && pin.rulesSha256 === c.rulesHash &&
    wire.termsSha256 === pin.termsSha256 && pin.termsSha256 === c.termsHash &&
    wire.rubricSha256 === pin.rubricSha256 && pin.rubricSha256 === c.rubricHash &&
    wire.mediaPolicySha256 === pin.mediaPolicySha256 && pin.mediaPolicySha256 === c.mediaPolicyHash,
    "dance_v2_policy_binding_mismatch");
  const r = c.reference, ref = wire.referenceSelection;
  insist(ref.startSample === BigInt(c.startSample) && ref.durationSamples === BigInt(c.durationSamples) &&
    ref.present === (r !== null) && ref.id === (r ? consentDigest(r.id) : zeroHash) &&
    ref.revision === (r ? BigInt(r.revision) : 0n) && ref.epoch === (r ? BigInt(r.epoch) : 0n) &&
    ref.segmentId === (r ? consentDigest(r.segmentId) : zeroHash) &&
    ref.segmentLayoutSha256 === (r ? r.segmentLayoutSha256 : zeroHash), "dance_v2_reference_binding_mismatch");
  const o = c.offer, offer = wire.offer;
  insist(offer.present === (o !== null) && offer.offerIdCommitment === (o ? danceOfferId(domain, o.offerId) : zeroHash) &&
    offer.inputHash === (o ? o.inputHash : zeroHash) && offer.sourceHash === (o ? o.sourceHash : zeroHash) &&
    offer.opensAtMs === (o ? BigInt(o.opensAtMs) : 0n) && offer.cutoffAtMs === (o ? BigInt(o.cutoffAtMs) : 0n) &&
    (!o || (o.offerIdCommitment === offer.offerIdCommitment && o.sourceHash === c.canonical.sourceHash)),
    "dance_offer_binding_mismatch");
  const b = object(p.binding); exact(b, ["schema", "source", "grantId", "grant", "recordedAtS", "boundAtS", "localFenceGeneration"]);
  insist(b.schema === "pirate.bound-publication-grant/1", "dance_v2_publication_binding_mismatch");
  const s = object(b.source); exact(s, ["schema", "resultsVersion", "chainId", "communityId", "installationId",
    "directory", "directoryRuntimeHash", "registry", "registryRuntimeHash", "releaseSelectionSha256"]);
  id(s.installationId); consentDigest(s.releaseSelectionSha256);
  insist(s.schema === "pirate.publication-source/1" && s.resultsVersion === 5 && s.chainId === Number(domain.chainId) &&
    consentDigest(s.communityId) === domain.communityId && consentAddress(s.directory) === pin.directory.toLowerCase() &&
    consentDigest(s.directoryRuntimeHash) === pin.directoryRuntimeHash && consentAddress(s.registry) === pin.consentRegistry.toLowerCase() &&
    consentDigest(s.registryRuntimeHash) === pin.consentRegistryRuntimeHash, "dance_v2_publication_source_mismatch");
  const grant = parsePublicationGrant(b.grant);
  const grantId = hashTypedData({ domain: publicationDomain(domain.chainId, consentAddress(s.registry)),
    types: publicationConsentTypes, primaryType: "PublicationGrant", message: grant });
  const recorded = consentUint64(b.recordedAtS), bound = consentUint64(b.boundAtS);
  consentUint64(b.localFenceGeneration);
  insist(consentDigest(b.grantId) === grantId && wire.publicationGrantId === grantId &&
    grant.learner === c.learner.wallet && grant.communityId === domain.communityId && grant.purpose === "dance-verdict" &&
    grant.publicationTarget === domain.verifier && grant.publicationTargetRuntimeHash === pin.runtimeCodeHash &&
    grant.policyHash === pin.learnerConsentPolicyHash && bound === BigInt(c.reservedAtMs) / 1000n &&
    recorded > 0n && recorded <= bound && grant.validAfter <= bound && bound < grant.expiresAt,
    "dance_v2_publication_binding_mismatch");
  return pin.publicityPolicyHash;
}

function mediaConsent(c: CaptureFieldsV2, requireConsent: boolean, publicity?: Hex) {
  if (requireConsent) insist(c.consent !== null, "dance_consent_required", 403);
  if (c.consent === null) return;
  const r = object(c.consent); exact(r, ["accepted", "version", "termsHash", "publicityPolicyHash",
    "receiptId", "accountId", "captureId", "captureHash", "acceptedAtMs"]);
  label(r.version); id(r.receiptId); id(r.accountId); consentDigest(r.publicityPolicyHash);
  insist(r.accepted === true && r.accountId === c.learner.accountId && consentDigest(r.captureId) === c.captureId &&
    consentDigest(r.captureHash) === c.captureHash && consentDigest(r.termsHash) === c.termsHash &&
    (!publicity || r.publicityPolicyHash === publicity) && uint(r.acceptedAtMs, 1) >= c.reservedAtMs &&
    uint(r.acceptedAtMs, 1) < c.expiresAtMs, "dance_consent_binding_mismatch");
}

export function parseDanceCaptureV2(value: unknown, requireConsent = true): DanceCaptureV2 {
  const c = object(value); exact(c, captureKeys); fields(c); consentDigest(c.captureHash);
  const p = object(c.publication);
  if (p.kind === "private") {
    privateFields(c);
    insist(hashPrivateDanceCaptureV2(c as unknown as PrivateCaptureV2) === c.captureHash, "dance_v2_private_hash_mismatch");
    mediaConsent(c as unknown as PrivateCaptureV2, requireConsent);
  } else {
    const publicity = publication(c as unknown as PublicationCaptureV2);
    mediaConsent(c as unknown as PublicationCaptureV2, requireConsent, publicity);
  }
  return frozen(structuredClone(c)) as unknown as DanceCaptureV2;
}

export function parseStoredDanceCapture(value: unknown, requireConsent = true): StoredDanceCapture {
  if (value && typeof value === "object" && "version" in value && value.version === DANCE_VERSION) {
    const legacy = value as DanceCapture; validateCapture(legacy, requireConsent); return legacy;
  }
  return parseDanceCaptureV2(value, requireConsent);
}

/** Request syntax only. Permission binding, capture allocation and the later
 * trusted media-consent receipt remain separate caller-owned operations. */
export function parseCaptureRequestV2(value: unknown): CaptureRequestV2 {
  const r = object(value); exact(r, ["version", "commandId", "target", "publication", "consent"]);
  insist(r.version === "pirate.dance-capture-request/2", "dance_v2_request_invalid"); id(r.commandId);
  const t = object(r.target); exact(t, ["communityId", "songKey", "songRevision", "audioSha256", "reference", "offerId"]);
  [t.communityId, t.songKey, t.audioSha256].forEach(v => consentDigest(v)); uint(t.songRevision, 1);
  if (t.reference !== null) { const ref = object(t.reference); exact(ref, ["id", "revision"]); id(ref.id); uint(ref.revision, 1); }
  if (t.offerId !== null) id(t.offerId);
  const p = object(r.publication);
  if (p.kind === "private") exact(p, ["kind"]);
  else { exact(p, ["kind", "publicationCommandId"]); insist(p.kind === "publication-bound", "dance_v2_publication_invalid"); consentDigest(p.publicationCommandId); }
  const c = object(r.consent); exact(c, ["accepted", "version", "termsHash", "publicityPolicyHash"]);
  insist(c.accepted === true, "dance_consent_required", 403); label(c.version); consentDigest(c.termsHash); consentDigest(c.publicityPolicyHash);
  return frozen(structuredClone(r)) as unknown as CaptureRequestV2;
}
