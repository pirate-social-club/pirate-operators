/** Pure DTO construction with actual V2 ABI and EIP-712 hashing; not authority,
 * a recorded publication command, fresh-ID allocation or provider evidence. */
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { hashJson } from "../../packages/community/common.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  DANCE_VERSION,
  type DanceCapture,
  type DanceConsentReceipt,
} from "../../packages/dance/contracts.ts";
import type {
  PrivateCaptureV2,
  PublicationCaptureV2,
} from "../../packages/dance/capture-v2.ts";
import { danceShapes } from "../../packages/dance-chain/v2/wire-shapes.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  danceOfferId,
  danceSourceHash,
  type DanceCapture as WireCapture,
} from "../../packages/dance-chain/v2/wire.ts";
import { songKeyOf } from "../../packages/protocol/records.ts";
import { preparePublicationGrant } from "../../packages/protocol/publication-consent.ts";
import type {
  BoundPublicationGrantV1,
  GrantWireV1,
} from "../../packages/protocol/publication-runtime-v1.ts";

export const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

export function danceCaptureV2Fixture() {
  const seconds = 1_800_000_000n,
    reserved = Number(seconds * 1000n) + 123;
  const domain = { chainId: 6343n, verifier: address(2), communityId: word(3) };
  const learner = {
    accountId: "11111111-1111-4111-8111-111111111111",
    wallet: address(4),
  };
  const pin = {
    directory: address(5),
    directoryRuntimeHash: word(6),
    consentRegistry: address(7),
    consentRegistryRuntimeHash: word(8),
    posts: address(9),
    postsRuntimeHash: word(10),
    executionRule: keccak256(stringToHex("directory-current-publisher/1")),
    learnerConsentPolicyHash: word(11),
    reviewerConsentPolicyHash: word(12),
    publicityPolicyHash: word(13),
    rulesSha256: word(14),
    termsSha256: word(15),
    rubricSha256: word(16),
    mediaPolicySha256: word(17),
    deploymentBlock: 1n,
    runtimeCodeHash: word(18),
  };
  const grant = {
    learner: learner.wallet,
    communityId: domain.communityId,
    purpose: "dance-verdict" as GrantWireV1["purpose"],
    publicationTarget: domain.verifier,
    publicationTargetRuntimeHash: pin.runtimeCodeHash,
    permissionRevision: "2",
    policyHash: pin.learnerConsentPolicyHash,
    withdrawalEpoch: "0",
    nonce: word(19),
    issuedAt: String(seconds - 20n),
    validAfter: String(seconds - 20n),
    expiresAt: String(seconds + 600n),
    submitBefore: String(seconds + 10n),
  } satisfies GrantWireV1;
  const binding = {
    schema: "pirate.bound-publication-grant/1" as const,
    source: {
      schema: "pirate.publication-source/1" as const,
      resultsVersion: 5 as const,
      chainId: 6343 as const,
      communityId: domain.communityId,
      installationId: word(20),
      directory: pin.directory,
      directoryRuntimeHash: pin.directoryRuntimeHash,
      registry: pin.consentRegistry,
      registryRuntimeHash: pin.consentRegistryRuntimeHash,
      releaseSelectionSha256: word(21),
    },
    grantId: preparePublicationGrant(
      domain.chainId,
      pin.consentRegistry,
      grant,
      "0x",
    ).digest,
    grant,
    recordedAtS: String(seconds - 10n),
    boundAtS: String(seconds),
    localFenceGeneration: "4",
  } satisfies BoundPublicationGrantV1;
  const sourceHash = danceSourceHash(domain, pin);
  const wire: WireCapture = {
    captureId: word(22),
    accountCommitment: danceAccountCommitment(
      domain,
      learner.accountId,
      learner.wallet,
    ),
    learner: learner.wallet,
    identityEpoch: 3n,
    groupId: word(23),
    groupEpoch: 4n,
    publicationGrantId: binding.grantId,
    reservedAtMs: BigInt(reserved),
    song: {
      chainId: domain.chainId,
      posts: pin.posts,
      communityId: domain.communityId,
      postId: word(24),
      revision: 5n,
      manifestSha256: word(25),
      audioSha256: word(26),
    },
    rulesSha256: pin.rulesSha256,
    termsSha256: pin.termsSha256,
    rubricSha256: pin.rubricSha256,
    mediaPolicySha256: pin.mediaPolicySha256,
    referenceSelection: {
      present: true,
      id: word(27),
      revision: 6n,
      epoch: 7n,
      segmentLayoutSha256: word(28),
      segmentId: word(29),
      startSample: 96000n,
      durationSamples: 288000n,
    },
    offer: {
      present: true,
      offerIdCommitment: danceOfferId(domain, "offer_capture_fixture"),
      inputHash: word(30),
      sourceHash,
      opensAtMs: (seconds - 10n) * 1000n,
      cutoffAtMs: (seconds + 120n) * 1000n,
    },
  };
  const common = {
    version: "pirate.dance/2" as const,
    captureId: wire.captureId,
    communityId: domain.communityId,
    learner,
    songKey: songKeyOf({ ...wire.song, chainId: 6343 }),
    songRevision: 5,
    songDurationSamples: 2_880_000,
    manifestSha256: wire.song.manifestSha256,
    audioSha256: wire.song.audioSha256,
    mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
    mediaPolicyHash: pin.mediaPolicySha256,
    reference: {
      id: word(27),
      revision: 6,
      epoch: 7,
      segmentId: word(29),
      segmentLayoutSha256: word(28),
    },
    startSample: 96000,
    durationSamples: 288000,
    policy: "moderator-review-policy-v2" as const,
    rulesHash: pin.rulesSha256,
    termsHash: pin.termsSha256,
    rubricHash: pin.rubricSha256,
    rubricText: "Fixture retained rubric.",
    offer: {
      offerId: "offer_capture_fixture",
      offerIdCommitment: wire.offer.offerIdCommitment,
      inputHash: word(30),
      sourceHash,
      opensAtMs: Number(wire.offer.opensAtMs),
      cutoffAtMs: Number(wire.offer.cutoffAtMs),
    },
    reservedAtMs: reserved,
    expiresAtMs: reserved + 60_000,
  };
  const bound = {
    ...structuredClone(common),
    publication: {
      kind: "publication-bound" as const,
      publicationCommandId: word(31),
      binding,
    },
    canonical: {
      encoding: "pirate.dance-capture-abi/2" as const,
      domain: {
        chainId: String(domain.chainId),
        verifier: domain.verifier,
        communityId: domain.communityId,
      },
      sourceHash,
      sourcePinAbi: encodeAbiParameters([danceShapes.sourcePin], [pin]),
      captureAbi: encodeAbiParameters([danceShapes.capture], [wire]),
    },
    expected: {
      ownerEpoch: "7",
      configurationRevision: "99",
      rulesEpoch: "0",
      mediaEpoch: "0",
    },
    captureHash: danceCaptureHash(domain, wire),
    consent: null as DanceConsentReceipt | null,
  } satisfies PublicationCaptureV2;
  const privateSnapshot = {
    ...structuredClone(common),
    publication: { kind: "private" as const },
    canonical: null,
    expected: { configurationRevision: 99, rulesEpoch: 0, mediaEpoch: 0 },
  } satisfies Omit<PrivateCaptureV2, "captureHash" | "consent">;
  // Independent literal preimage witness: do not call the implementation's hasher here.
  const privateCapture = {
    ...privateSnapshot,
    captureHash: hashJson({
      schema: "pirate.dance-private-capture/2",
      capture: privateSnapshot,
    }),
    consent: null as DanceConsentReceipt | null,
  } satisfies PrivateCaptureV2;
  const legacy = {
    ...structuredClone(common),
    version: DANCE_VERSION,
    captureId: "legacy_capture_01",
    learner: {
      ...learner,
      active: true,
      identityEpoch: 3,
      groupId: word(23),
      groupEpoch: 4,
      knownAliases: [learner.accountId],
      authorizationId: word(32),
      accountCommitment: word(33),
    },
    source: {
      chainId: 6343,
      address: domain.verifier,
      runtimeCodeHash: pin.runtimeCodeHash,
      fromBlock: "1",
      communityId: domain.communityId,
      publisher: address(34),
      policyHash: pin.publicityPolicyHash,
      sourceHash,
    },
    expected: {
      ownerEpoch: 7,
      configurationRevision: 99,
      rulesEpoch: 0,
      mediaEpoch: 0,
    },
    captureHash: word(35),
    consent: null as DanceConsentReceipt | null,
  } satisfies DanceCapture;
  function receipt(
    c: Pick<
      typeof bound,
      "captureId" | "captureHash" | "learner" | "termsHash" | "reservedAtMs"
    >,
  ): DanceConsentReceipt {
    return {
      accepted: true,
      version: "dance-consent-fixture/2",
      termsHash: c.termsHash,
      publicityPolicyHash: pin.publicityPolicyHash,
      receiptId: "consent_fixture_01",
      accountId: c.learner.accountId,
      captureId: c.captureId,
      captureHash: c.captureHash,
      acceptedAtMs: c.reservedAtMs + 1,
    };
  }
  return {
    domain,
    pin,
    wire,
    bound,
    privateSnapshot,
    privateCapture,
    legacy,
    receipt,
    refresh() {
      bound.canonical.sourceHash = danceSourceHash(domain, pin);
      bound.canonical.sourcePinAbi = encodeAbiParameters(
        [danceShapes.sourcePin],
        [pin],
      );
      bound.canonical.captureAbi = encodeAbiParameters(
        [danceShapes.capture],
        [wire],
      );
      bound.captureHash = danceCaptureHash(domain, wire);
    },
    rebind() {
      binding.grantId = preparePublicationGrant(
        domain.chainId,
        pin.consentRegistry,
        grant,
        "0x",
      ).digest;
      wire.publicationGrantId = binding.grantId;
      bound.canonical.captureAbi = encodeAbiParameters(
        [danceShapes.capture],
        [wire],
      );
      bound.captureHash = danceCaptureHash(domain, wire);
    },
  };
}
