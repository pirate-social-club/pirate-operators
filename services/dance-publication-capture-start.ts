import { encodeAbiParameters, zeroHash, type Address, type Hex } from "viem";
import type { AuthContext } from "../packages/community/accounts.ts";
import { bytes32, canonical, insist } from "../packages/community/common.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  type DanceCapture,
} from "../packages/dance-chain/v2/wire.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import {
  parseCaptureRequestV2,
  parseDanceCaptureV2,
  type CaptureRequestV2,
  type PublicationCaptureV2,
  type StoredDanceCapture,
} from "../packages/dance/capture-v2.ts";
import type {
  DanceConsentPolicy,
  DanceFence,
} from "../packages/dance/contracts.ts";
import { sameDanceTarget } from "../packages/dance/production.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  validateConsent,
  validateFence,
} from "../packages/dance/validation.ts";
import { consentAddress } from "../packages/protocol/publication-consent.ts";
import { createDancePublicationJournal } from "./dance-publication-journal.ts";
import { readDancePublicationAdmission } from "./dance-publication-reader.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { PublicationRequestSession } from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { parseCommand } from "./publication-command-contract.ts";
import { ownedCommand } from "./publication-command-store.ts";

type StartSnapshot = Omit<
  PublicationCaptureV2,
  "publication" | "canonical" | "captureHash" | "consent"
>;
type BoundCaptureRequest = CaptureRequestV2 & {
  publication: Pick<
    PublicationCaptureV2["publication"],
    "kind" | "publicationCommandId"
  >;
};

export interface DancePublicationCaptureSelection {
  source: DancePublicationSourceV2;
  publisher: Address;
  owner: { epoch: bigint; wallet: Address };
  /** Authenticates a new public-metadata capture start on the selected source.
   * The new capture ID and DB-observed start instant are durably reserved once
   * per exact command before waiting for the canonical safe block. Repeated
   * requests read that same start. Private captures cannot supply this record.
   * Fences must cover the original and current canonical song/audio/reference,
   * offer, identity group, owner/configuration, rules and media selection. */
  retainStart(input: {
    actor: Readonly<{
      accountId: string;
      wallet: Address;
      bindingId: string;
      authorId: Hex;
    }>;
    request: BoundCaptureRequest;
    requestHash: string;
    grantId: Hex;
    /** Consume in the same write that records the new start. */
    authorization: DanceFence;
    source: DancePublicationSourceV2;
  }): Promise<{
    snapshot: StartSnapshot;
    postId: Hex;
    identity: Pick<DanceCapture, "identityEpoch" | "groupId" | "groupEpoch">;
    consent: DanceConsentPolicy;
    fences: readonly DanceFence[];
  }>;
}

function encodeCapture(
  { domain, pin }: DancePublicationSourceV2,
  c: StartSnapshot,
  postId: Hex,
  identity: Pick<DanceCapture, "identityEpoch" | "groupId" | "groupEpoch">,
  grantId: Hex,
): DanceCapture {
  const r = c.reference,
    o = c.offer;
  return {
    ...identity,
    captureId: c.captureId,
    accountCommitment: danceAccountCommitment(
      domain,
      c.learner.accountId,
      c.learner.wallet,
    ),
    learner: c.learner.wallet,
    publicationGrantId: grantId,
    reservedAtMs: BigInt(c.reservedAtMs),
    song: {
      chainId: domain.chainId,
      communityId: domain.communityId,
      posts: pin.posts,
      postId,
      revision: BigInt(c.songRevision),
      manifestSha256: bytes32(c.manifestSha256),
      audioSha256: bytes32(c.audioSha256),
    },
    rulesSha256: bytes32(c.rulesHash),
    termsSha256: bytes32(c.termsHash),
    rubricSha256: bytes32(c.rubricHash),
    mediaPolicySha256: bytes32(c.mediaPolicyHash),
    referenceSelection: {
      present: r !== null,
      id: r ? bytes32(r.id) : zeroHash,
      revision: BigInt(r?.revision ?? 0),
      epoch: BigInt(r?.epoch ?? 0),
      segmentLayoutSha256: r ? bytes32(r.segmentLayoutSha256) : zeroHash,
      segmentId: r ? bytes32(r.segmentId) : zeroHash,
      startSample: BigInt(c.startSample),
      durationSamples: BigInt(c.durationSamples),
    },
    offer: {
      present: o !== null,
      offerIdCommitment: o ? bytes32(o.offerIdCommitment) : zeroHash,
      inputHash: o ? bytes32(o.inputHash) : zeroHash,
      sourceHash: o ? bytes32(o.sourceHash) : zeroHash,
      opensAtMs: BigInt(o?.opensAtMs ?? 0),
      cutoffAtMs: BigInt(o?.cutoffAtMs ?? 0),
    },
  };
}

/** Start a new recording with separately recorded, purpose-specific consent
 * for its eventual verdict metadata. The media receipt remains independent.
 * This service only reserves capture and records private-media consent. */
export async function startDancePublicationCapture(
  request: Request,
  value: CaptureRequestV2,
  context: AuthContext,
  ports: PublicationApplicationPorts,
  selected: DancePublicationCaptureSelection | undefined,
): Promise<PublicationCaptureV2> {
  insist(request.method === "POST", "method_not_allowed", 405);
  const { db, catalog, installation, client } = ports,
    clock = { ...ports.clock };
  insist(
    selected && installation && catalog.active,
    "dance_publication_capture_unavailable",
    503,
  );
  const { source, publisher, owner } = structuredClone({
    source: selected.source,
    publisher: selected.publisher,
    owner: selected.owner,
  });
  const retainStart = selected.retainStart.bind(selected);
  const release = catalog.fresh(),
    descriptor = release.policies["dance-verdict"],
    reviewer = release.policies["dance-review-attribution"];
  const releaseSource = publicationSelectionSource(release);
  insist(
    source.domain.chainId === BigInt(releaseSource.chainId) &&
      source.domain.communityId === releaseSource.communityId &&
      source.pin.directory === releaseSource.directory &&
      source.pin.directoryRuntimeHash === releaseSource.directoryRuntimeHash &&
      source.pin.consentRegistry === releaseSource.registry &&
      source.pin.consentRegistryRuntimeHash ===
        releaseSource.registryRuntimeHash &&
      source.pin.posts === release.configuration.postsContract &&
      descriptor?.target === source.domain.verifier &&
      descriptor.runtimeHash === source.pin.runtimeCodeHash &&
      descriptor.policyHash === source.pin.learnerConsentPolicyHash &&
      descriptor.dancePublicityPolicyHash === source.pin.publicityPolicyHash &&
      reviewer?.target === source.domain.verifier &&
      reviewer.runtimeHash === source.pin.runtimeCodeHash &&
      reviewer.policyHash === source.pin.reviewerConsentPolicyHash &&
      reviewer.dancePublicityPolicyHash === source.pin.publicityPolicyHash,
    "dance_publication_source_changed",
    503,
  );
  const expectedAccount = request.headers.get("x-dance-account");
  const body = parseCaptureRequestV2(value);
  const session = await PublicationRequestSession.open(
    request,
    db,
    context,
    installation,
  );
  const original = session.original;
  const actor = Object.freeze({
    accountId: original.account_id,
    wallet: consentAddress(original.wallet.toLowerCase()),
    bindingId: original.binding_id,
    authorId: bytes32(original.author_id),
  });
  insist(expectedAccount === actor.accountId, "dance_account_changed", 409);
  insist(
    body.target.communityId === session.context.communityId &&
      body.publication.kind === "publication-bound",
    "dance_publication_capture_required",
    403,
  );
  const bound: BoundCaptureRequest = Object.freeze({
    ...body,
    publication: body.publication,
  });
  const commandId = bound.publication.publicationCommandId;
  const ownership = {
    communityId: session.context.communityId,
    accountId: actor.accountId,
  };
  const store = new DanceStore(db),
    hash = DanceStore.request("capture-v2", body);
  const writeAuthority = session.mutationFence({
    db,
    ...ownership,
    source: releaseSource,
    active: true,
  });
  const find = () =>
    store.findStoredCapture(
      ownership.communityId,
      actor.accountId,
      body.commandId,
      hash,
    );
  const previous = await find();
  await session.check();
  if (previous) {
    insist(
      previous.version === "pirate.dance/2" &&
        previous.publication.kind === "publication-bound",
      "dance_capture_binding_mismatch",
      409,
    );
  }
  function sameOriginal(value: StoredDanceCapture, c: PublicationCaptureV2) {
    insist(
      value.version === c.version &&
        canonical({ ...value, consent: null }) === canonical(c),
      "dance_capture_binding_mismatch",
      409,
    );
  }
  // Read the explicit owned grant command. The binding journal below checks
  // the original retained command, signature, activation and canonical receipt.
  const row = await ownedCommand(db, commandId, ownership);
  await session.check();
  insist(
    row.typed_json && row.phase === "accepted",
    "dance_publication_not_recorded",
    403,
  );
  const grant = parseCommand(JSON.parse(row.typed_json));
  insist(
    grant.action === "grant" &&
      grant.commandId === commandId &&
      grant.message.purpose === "dance-verdict" &&
      grant.message.learner === actor.wallet &&
      canonical(grant.source) === canonical(releaseSource),
    "dance_publication_original_changed",
    403,
  );
  const journal = createDancePublicationJournal(ports, session);
  const receipt = await journal.reconcileOriginal(grant);
  await session.check();
  insist(receipt.state === "recorded", "dance_publication_not_recorded", 403);

  const start = await retainStart({
    actor,
    request: bound,
    requestHash: hash,
    grantId: grant.digest,
    authorization: structuredClone(writeAuthority),
    source: structuredClone(source),
  });
  const {
    snapshot: c,
    postId,
    identity,
    consent,
  } = structuredClone({
    snapshot: start.snapshot,
    postId: start.postId,
    identity: start.identity,
    consent: start.consent,
  });
  const fences = start.fences.map(validateFence);
  await session.check();
  insist(
    fences.length > 0 &&
      consent.admission === "admitted" &&
      canonical(c.learner) ===
        canonical({ accountId: actor.accountId, wallet: actor.wallet }) &&
      c.expected.configurationRevision ===
        String(release.configuration.configurationRevision) &&
      c.expected.ownerEpoch === String(owner.epoch) &&
      c.termsHash === consent.termsHash &&
      consent.publicityPolicyHash === descriptor.dancePublicityPolicyHash &&
      sameDanceTarget(body.target, {
        communityId: c.communityId,
        songKey: c.songKey,
        songRevision: c.songRevision,
        audioSha256: c.audioSha256,
        reference: c.reference,
        offerId: c.offer?.offerId ?? null,
      }),
    "dance_capture_binding_mismatch",
    409,
  );
  validateConsent(body.consent, consent);
  const wire = encodeCapture(source, c, postId, identity, grant.digest);
  const plan = await journal.prepareCapture({
    commandId,
    capture: wire,
    configurationRevision: c.expected.configurationRevision,
    ownerEpoch: c.expected.ownerEpoch,
  });
  const capture = parseDanceCaptureV2(
    {
      ...c,
      publication: {
        ...body.publication,
        binding: plan.grant.binding,
      },
      canonical: {
        encoding: "pirate.dance-capture-abi/2",
        domain: {
          chainId: String(source.domain.chainId),
          verifier: source.domain.verifier,
          communityId: source.domain.communityId,
        },
        sourceHash: source.sourceHash,
        sourcePinAbi: encodeAbiParameters(
          [danceShapes.sourcePin],
          [source.pin],
        ),
        captureAbi: encodeAbiParameters([danceShapes.capture], [wire]),
      },
      captureHash: danceCaptureHash(source.domain, wire),
      consent: null,
    },
    false,
  ) as PublicationCaptureV2;
  if (previous) sameOriginal(previous, capture);
  const proof = await readDancePublicationAdmission({
    db,
    journal,
    client,
    clock,
    selected: source,
    caller: publisher,
    owner,
    config: release.configuration,
    profile: parseWeb2ProfileDocument(release.profile),
    releaseSelectionSha256: releaseSource.releaseSelectionSha256,
    original: { kind: "capture", capture: wire, learner: plan.grant },
  });
  // The start's source read may precede the final grant anchor. Recheck these
  // immutable capture inputs at the same canonical state as that final proof.
  const at = { blockHash: proof.anchor.hash, requireCanonical: true } as const;
  const verifier = {
    address: source.domain.verifier,
    abi: danceVerdictsAbi,
    ...at,
  } as const;
  const [[wallet, epoch, group, groupEpoch, active], groupState, rules, song] =
    await Promise.all([
      client.readContract({
        ...verifier,
        functionName: "identities",
        args: [wire.accountCommitment],
      }),
      client.readContract({
        ...verifier,
        functionName: "groups",
        args: [wire.groupId],
      }),
      client.readContract({ ...verifier, functionName: "rulesEpoch" }),
      client.readContract({
        address: source.pin.posts,
        abi: postsAbi,
        ...at,
        functionName: "getPost",
        args: [wire.song.communityId, wire.song.postId],
      }),
    ]);
  insist(
    active &&
      wallet.toLowerCase() === actor.wallet &&
      epoch === wire.identityEpoch &&
      group === wire.groupId &&
      groupEpoch === wire.groupEpoch &&
      groupState[4] &&
      groupState[0] === wire.groupEpoch &&
      groupState[1] > 0n &&
      rules === BigInt(c.expected.rulesEpoch) &&
      song.kind === 0 &&
      song.revision === wire.song.revision &&
      song.manifestSha256 === wire.song.manifestSha256,
    "dance_publication_capture_context_changed",
    409,
  );
  const anchor = await client.getBlock({ blockNumber: proof.anchor.number });
  insist(
    anchor.hash === proof.anchor.hash &&
      anchor.timestamp === proof.anchor.timestamp,
    "dance_publication_anchor_changed",
    503,
  );
  const authority = [
    ...fences,
    ...proof.fences,
    writeAuthority,
    { sql: DANCE_DB_NOW + "<?", values: [capture.expiresAtMs] },
  ];
  await session.check();
  if (!previous) {
    try {
      await store.reserveCaptureV2(
        capture,
        actor.accountId,
        body.commandId,
        hash,
        authority,
        {
          kind: "publication-bound",
          bindingPlan: plan,
        },
      );
    } catch (error) {
      await session.check();
      const retained = await find();
      if (!retained) throw error;
      sameOriginal(retained, capture);
    }
  }
  await session.check();
  const accepted = await store.acceptConsentV2(
    capture,
    body.consent,
    body.commandId,
    [
      ...authority,
      {
        sql: "EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND capture_hash=? AND account_id=? AND purpose='dance-verdict' AND command_id=?)",
        values: [
          capture.communityId,
          capture.captureId,
          capture.captureHash,
          actor.accountId,
          commandId,
        ],
      },
    ],
  );
  await session.check();
  insist(
    accepted.publication.kind === "publication-bound",
    "dance_capture_binding_mismatch",
    409,
  );
  return accepted as PublicationCaptureV2;
}
