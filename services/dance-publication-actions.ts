import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import type { DanceBlock } from "../packages/dance-chain/reader.ts";
import type { AccountSession, AuthContext } from "../packages/community/accounts.ts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import {
  mediaSubmissionReceipt,
  prepareMediaSubmission,
} from "../packages/community-media/submission.ts";
import { readyFacts } from "../packages/community-media/validation.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import {
  danceCommand,
  danceConsentHash,
  danceMediaBinding,
  danceMediaId,
  danceRecordingBinding,
  danceRecordingReplay,
  danceReviewerConsent,
  danceSubmissionHash,
  danceSubmissionId,
  type DanceDecision,
} from "../packages/dance-chain/v2/wire.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import {
  parseDanceCaptureV2,
  type PublicationCaptureV2,
} from "../packages/dance/capture-v2.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import {
  dancePublicationStatusVersion, isDancePublicationRequestId, readDancePublicationStatus, type DancePublicationStatus,
} from "../packages/dance/publication-status.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { danceId, validateFence } from "../packages/dance/validation.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { CommunityPrivateDance } from "./community-private-dance.ts";
import { createDancePublicationJournal } from "./dance-publication-journal.ts";
import { readDancePublicationAdmission } from "./dance-publication-reader.ts";
import { observeRetainedDanceV2Action, recoverDanceV2Action, type DanceV2Observation } from "./dance-v2-action-recovery.ts";
import { readDanceV2ParticipantBindings } from "./dance-v2-participant-bindings.ts";
import {
  DanceV2ActionStore,
  danceActionAcceptanceContext,
  danceDispatchSessionPin,
  type DanceV2Action,
  type DanceV2ReadyCommand,
} from "./dance-v2-action-store.ts";
import { PublicationRequestSession } from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { parseCommand } from "./publication-command-contract.ts";
import { ownedCommand } from "./publication-command-store.ts";
import {
  web2PublicDanceStart,
  type Web2PublicDanceInputs,
} from "./web2-public-dance-start.ts";

const registerPath = "/api/dance/reviews";
const verdictPath = /^\/api\/dance\/reviews\/(0x[0-9a-f]{64})\/verdict$/;
const submissionStatusPath = /^\/api\/dance\/reviews\/(0x[0-9a-f]{64})\/submission-status$/;
export const danceV2ActionRoute = (path: string) =>
  path === registerPath || verdictPath.test(path);
export const danceV2SubmissionStatusRoute = (path: string) => submissionStatusPath.test(path);

function registrationContext(captureHash: Hex, binding: Hex, publisher: string) {
  return hashJson({ captureHash, binding, publisher });
}

function registrationCommand(
  selected: Web2PublicDanceInputs,
  capture: PublicationCaptureV2,
  action: DanceV2Action,
  receipt: Awaited<ReturnType<typeof mediaSubmissionReceipt>>,
  sessionPin?: Hex,
) {
  const { source, publisher } = selected,
    { domain } = source;
  const [wire] = decodeAbiParameters(
    [danceShapes.capture],
    capture.canonical.captureAbi,
  );
  const original = object(JSON.parse(action.input_json));
  const recording = bytes32(original.recordingSha256);
  const mediaId = danceMediaId(domain, receipt.mediaId),
    generation = BigInt(receipt.mediaRevision);
  const binding = danceMediaBinding(
    domain,
    capture.captureHash,
    mediaId,
    generation,
    recording,
  );
  const consent = {
    accepted: true,
    acceptedAtMs: BigInt(capture.consent!.acceptedAtMs),
    captureHash: capture.captureHash,
    termsSha256: bytes32(capture.termsHash),
    publicityPolicyHash: bytes32(capture.consent!.publicityPolicyHash),
  };
  const context = registrationContext(capture.captureHash, binding, publisher);
  insist(
    receipt.accountId === capture.learner.accountId &&
      receipt.communityId === capture.communityId &&
      receipt.submissionId === capture.captureId &&
      receipt.mediaId === original.mediaId &&
      receipt.bindingCommitment === binding &&
      (action.context_sha256 === context ||
        (sessionPin && action.context_sha256 === danceActionAcceptanceContext(context, sessionPin))) &&
      receipt.trustedSubmittedAtMs === action.bound_at_ms &&
      receipt.trustedSubmittedAtMs >= capture.consent!.acceptedAtMs &&
      receipt.reviewDeadlineMs === action.bound_at_ms + 604800000,
    "dance_publication_submission_changed",
    409,
  );
  const submission = {
    submissionId: danceSubmissionId(domain, wire.learner, wire.captureId),
    captureHash: capture.captureHash,
    consentHash: danceConsentHash(domain, consent),
    mediaBindingHash: binding,
    mediaIdCommitment: mediaId,
    mediaGeneration: generation,
    recordingReplayKey: danceRecordingReplay(domain, recording),
    recordingBindingHash: danceRecordingBinding(domain, recording, binding),
    trustedSubmittedAtMs: BigInt(receipt.trustedSubmittedAtMs),
    reviewDeadlineMs: BigInt(receipt.reviewDeadlineMs),
    mediaExpiresAtMs: BigInt(receipt.reviewDeadlineMs),
  };
  const command = danceCommand(
    domain,
    "registerSubmission",
    publisher,
    action.command_id,
    {
      expectedOwnerEpoch: BigInt(capture.expected.ownerEpoch),
      expectedConfigurationRevision: BigInt(
        capture.expected.configurationRevision,
      ),
      expectedRulesEpoch: BigInt(capture.expected.rulesEpoch),
      expectedMediaEpoch: BigInt(capture.expected.mediaEpoch),
      capture: wire,
      consent,
      submission,
      recordingSha256: recording,
    },
  );
  return { command, wire, submission };
}

function retainedMediaFence(
  receipt: Awaited<ReturnType<typeof mediaSubmissionReceipt>>,
  recordingSha256: string,
): DanceFence {
  return {
    sql: `EXISTS(SELECT 1 FROM community_media m JOIN community_media_submissions s
      ON s.media_id=m.id AND s.community_id=m.community_id
      WHERE s.community_id=? AND s.submission_id=? AND s.media_id=? AND s.account_id=?
      AND s.binding_commitment=? AND s.submitted_at_ms=? AND s.deadline_ms=? AND s.media_revision=?
      AND m.state='ready' AND m.purpose='private-review' AND m.revision=s.media_revision
      AND m.expires_at=s.deadline_ms AND m.expires_at>${DANCE_DB_NOW}
      AND json_extract(m.body,'$.recordingSha256')=? AND json_extract(m.body,'$.submissionId')=s.submission_id
      AND json_extract(m.body,'$.publicConsent')=0 AND COALESCE(json_extract(m.body,'$.erasePending'),0)=0)`,
    values: [
      receipt.communityId,
      receipt.submissionId,
      receipt.mediaId,
      receipt.accountId,
      receipt.bindingCommitment,
      receipt.trustedSubmittedAtMs,
      receipt.reviewDeadlineMs,
      receipt.mediaRevision,
      recordingSha256,
    ],
  };
}

function readyCommand(
  selected: Web2PublicDanceInputs,
  command: { id: Hex; hash: Hex; encoded: Hex; data: Hex },
  resource: Hex,
): DanceV2ReadyCommand {
  return {
    command_id: command.id,
    source_hash: selected.source.sourceHash,
    publisher: selected.publisher,
    command_hash: command.hash,
    encoded: command.encoded,
    calldata: command.data,
    resource_id: resource,
  };
}

export async function readDanceV2PrivateRegistration(
  selected: Web2PublicDanceInputs,
  runtime: CommunityPrivateDance,
  capture: PublicationCaptureV2,
  store: DanceV2ActionStore,
) {
  const {
    source,
    publisher,
    publication: { client },
  } = selected;
  const repo = runtime.media.ports.repository;
  const captureId = bytes32(capture.captureId);
  const registrationAction = await store.read(
    source.domain.communityId,
    captureId,
    "register",
  );
  insist(
    registrationAction &&
      registrationAction.account_id === capture.learner.accountId,
    "dance_publication_submission_missing",
    409,
  );
  const retainedMedia = await mediaSubmissionReceipt(repo, captureId);
  const registered = registrationCommand(
    selected,
    capture,
    registrationAction,
    retainedMedia,
    await store.dispatchSessionPin(registrationAction.command_id),
  );
  const readyRegistration = await store.ready(registrationAction.command_id);
  insist(
    readyRegistration &&
      canonical({ ...readyRegistration }) ===
        canonical(
          readyCommand(
            selected,
            registered.command,
            registered.submission.submissionId,
          ),
        ),
    "dance_publication_submission_missing",
    409,
  );
  const record = await repo.get(retainedMedia.mediaId);
  await runtime.media.usable(record);
  const media = readyFacts(record);
  insist(
    media.purpose === "private-review" &&
      !record.publicConsent &&
      !record.erasePending &&
      media.submissionId === captureId &&
      media.accountId === capture.learner.accountId &&
      media.revision === retainedMedia.mediaRevision &&
      media.expiresAt === retainedMedia.reviewDeadlineMs &&
      record.submissionBindingCommitment === retainedMedia.bindingCommitment,
    "dance_publication_submission_changed",
    409,
  );
  const readFences = [
    store.fence(registrationAction),
    retainedMediaFence(retainedMedia, media.recordingSha256),
  ];
  async function verifyRegistration(
    anchor: DanceBlock,
    afterAwait: () => Promise<void>,
  ) {
    const contract = {
      address: source.domain.verifier,
      abi: danceVerdictsAbi,
      blockHash: anchor.hash,
      requireCanonical: true,
    } as const;
    const id = registered.submission.submissionId;
    const [[captureAbi, submissionAbi, hash], mediaState, command] =
      await Promise.all([
        client.readContract({
          ...contract,
          functionName: "registrationOf",
          args: [id],
        }),
        client.readContract({ ...contract, functionName: "media", args: [id] }),
        client.readContract({
          ...contract,
          functionName: "commandReceipts",
          args: [publisher, registered.command.id],
        }),
      ]);
    await afterAwait();
    insist(
      captureAbi === capture.canonical.captureAbi &&
        submissionAbi ===
          encodeAbiParameters(
            [danceShapes.submission],
            [registered.submission],
          ) &&
        hash === danceSubmissionHash(source.domain, registered.submission) &&
        mediaState[0] === 1n &&
        mediaState[1] &&
        command[0] === registered.command.hash &&
        command[1] === registered.command.operation &&
        command[2] === id &&
        command[3] === mediaState[0],
      "dance_publication_registration_unconfirmed",
      503,
    );
    return mediaState[0];
  }
  return { registered, retainedMedia, record, readFences, verifyRegistration };
}

export interface DancePublicationActionInput {
  request: Request;
  body: unknown;
  context: AuthContext;
  config: Web2CommunityConfig;
  reads: PublicReadPorts;
  selection: Web2PublicDanceInputs;
  runtime: CommunityPrivateDance;
}

export async function dancePublicationAction(input: DancePublicationActionInput, pinDispatchSession = false) {
  const { commandId, state } = await applyDancePublicationAction(input, undefined, pinDispatchSession);
  return { commandId, state };
}

type DancePublicationStatusScope = Pick<DancePublicationActionInput, "request" | "context" | "selection">;

async function readInstalledDancePublicationStatus(
  { request, context, selection }: DancePublicationStatusScope,
  captureId: Hex, kind: DanceV2Action["kind"], requestId: string,
  checkMount: () => Promise<void>, observe?: DanceV2Observation,
): Promise<DancePublicationStatus> {
  const { db, installation } = selection.publication;
  insist(installation, "dance_publication_runtime_unavailable", 503);
  const session = await PublicationRequestSession.open(request, db, context, installation);
  const accountId = session.original.account_id;
  insist(request.headers.get("x-dance-account") === accountId, "dance_account_changed", 409);
  const store = new DanceV2ActionStore(db);
  const saved = await store.read(context.communityId, captureId, kind);
  insist(saved && saved.account_id === accountId, "dance_not_found", 404);
  const body = object(JSON.parse(saved.input_json));
  insist(body.commandId === requestId, "dance_not_found", 404);
  const action = store.same(saved, store.original(context.communityId, captureId, kind, accountId, body));
  const ready = await store.ready(action.command_id);
  let state: DancePublicationStatus["state"] | "held" = "held";
  if (!ready) {
    if (observe && kind === "register") {
      const row = await db.withSession("first-primary").prepare(
        `SELECT json_extract(c.capture_json,'$.captureHash') AS capture_hash,s.binding_commitment
        FROM dance_captures c JOIN community_media_submissions s
          ON s.community_id=c.community_id AND s.submission_id=c.capture_id AND s.account_id=c.account_id
        WHERE c.community_id=? AND c.capture_id=? AND c.account_id=? AND s.media_id=? AND s.submitted_at_ms=?`,
      ).bind(context.communityId, captureId, accountId, danceId(body.mediaId), action.bound_at_ms)
        .first<{ capture_hash: Hex; binding_commitment: Hex }>();
      if (row && action.context_sha256 === danceActionAcceptanceContext(
        registrationContext(bytes32(row.capture_hash), bytes32(row.binding_commitment), selection.publisher),
        danceDispatchSessionPin(session.original),
      )) state = "awaiting_chain_clock";
    }
  } else if (observe) {
    try {
      const result = await observeRetainedDanceV2Action(store, action, ready, observe, request.signal);
      if (result.state !== "held") {
        state = readDancePublicationStatus({
          version: dancePublicationStatusVersion, requestId, actionId: action.command_id, state: result.state,
        }, requestId).state;
      }
    } catch {
      request.signal.throwIfAborted();
    }
    if (state === "awaiting_publisher") {
      const pin = store.dispatchSessionFence(action, context.origin, session.original);
      const live = await db.withSession("first-primary").prepare(`SELECT 1 AS allowed WHERE (${pin.sql})`)
        .bind(...pin.values).first<{ allowed: number }>();
      if (live?.allowed !== 1) state = "held";
    }
  }
  await checkMount();
  const unchanged = await store.ready(action.command_id);
  insist(canonical(unchanged && { ...unchanged }) === canonical(ready && { ...ready }),
    "dance_publication_original_changed", 503);
  await session.check();
  request.signal.throwIfAborted();
  insist(state !== "held", "dance_publication_status_unavailable", 503);
  return { version: dancePublicationStatusVersion, requestId, actionId: action.command_id, state };
}

export function readInstalledDanceSubmissionStatus(
  input: DancePublicationStatusScope, checkMount: () => Promise<void>, observe?: DanceV2Observation,
) {
  const url = new URL(input.request.url);
  const match = submissionStatusPath.exec(url.pathname);
  insist(input.request.method === "GET" && match && url.searchParams.size === 1,
    "dance_publication_status_invalid", 400);
  const requestId = url.searchParams.get("requestId");
  insist(isDancePublicationRequestId(requestId), "dance_invalid_id", 400);
  return readInstalledDancePublicationStatus(input, bytes32(match[1]), "register",
    requestId, checkMount, observe);
}

export async function installedDancePublicationAction(
  input: DancePublicationActionInput, checkMount: () => Promise<void>, observe: DanceV2Observation | undefined,
  dispatch: ((input: DancePublicationActionInput, commandId: Hex) => Promise<void>) | undefined,
) {
  const body = object(input.body);
  const requestId = body.commandId;
  insist(isDancePublicationRequestId(requestId), "dance_invalid_id", 400);
  const { commandId } = await applyDancePublicationAction(input, undefined, true, true);
  const path = new URL(input.request.url).pathname;
  const kind = path === registerPath ? "register" : "verdict";
  const captureId = bytes32(kind === "register" ? body.captureId : verdictPath.exec(path)?.[1]);
  const status = () => readInstalledDancePublicationStatus(input, captureId, kind, requestId, checkMount, observe);
  const observed = await status();
  insist(observed.actionId === commandId, "dance_publication_original_changed", 409);
  if (observed.state !== "awaiting_publisher") return observed;
  insist(dispatch, "dance_publication_status_unavailable", 503);
  try {
    await dispatch(input, commandId);
  } catch (error) {
    input.request.signal.throwIfAborted();
    // A timed-out or refused effect can still leave the immutable original
    // held. Report fresh status through observation instead of retrying here.
    if (!(error instanceof Error)) throw error;
  }
  return status();
}

/** Server-side fresh dispatch check of the retained original only. */
export async function revalidateAcceptedDancePublicationAction(
  input: DancePublicationActionInput,
  expected: Readonly<DanceV2ReadyCommand>,
  acceptedSession: Readonly<AccountSession>,
) {
  const result = await applyDancePublicationAction(input, { ready: { ...expected }, session: acceptedSession });
  insist(
    result.commandId === expected.command_id &&
      result.state === "awaiting_publisher" &&
      "dispatchAuthority" in result && result.dispatchAuthority,
    "dance_publication_original_not_dispatchable",
    409,
  );
  return result.dispatchAuthority;
}

async function applyDancePublicationAction(
  input: DancePublicationActionInput,
  verification?: { ready: DanceV2ReadyCommand; session: Readonly<AccountSession> },
  pinDispatchSession = false,
  installedStatus = false,
) {
  const { request, context, config, reads, runtime } = input;
  const verifyOnly = verification?.ready;
  const selected = input.selection;
  const { publication: ports, publisher, owner, source } = selected;
  const { db, installation, catalog, client } = ports;
  const path = new URL(request.url).pathname,
    registration = path === registerPath;
  const reviewId = verdictPath.exec(path)?.[1];
  insist(
    request.method === "POST" && (registration || reviewId),
    "method_not_allowed",
    405,
  );
  insist(
    installation &&
      runtime.db === db &&
      runtime.publicationV2 &&
      runtime.source3,
    "dance_publication_runtime_unavailable",
    503,
  );
  const body = object(input.body);
  exact(
    body,
    registration
      ? ["commandId", "captureId", "mediaId", "recordingSha256"]
      : ["commandId", "publicationCommandId", "verdict"],
  );
  danceId(body.commandId as string);
  const captureId = bytes32(registration ? body.captureId : reviewId);
  const session = verification
    ? await PublicationRequestSession.openNativeDanceDispatch(request, db, context, installation, verification.session)
    : await PublicationRequestSession.open(request, db, context, installation);
  const actor = { accountId: session.original.account_id };
  insist(
    request.headers.get("x-dance-account") === actor.accountId,
    "dance_account_changed",
    409,
  );
  const store = new DanceV2ActionStore(db);
  const acceptingSessionPin = danceDispatchSessionPin(session.original);
  const acceptanceContext = (hash: Hex) => installedStatus ? danceActionAcceptanceContext(hash, acceptingSessionPin) : hash;
  const role = registration ? "register" : "verdict";
  const original = store.original(
    context.communityId,
    captureId,
    role,
    actor.accountId,
    body,
  );
  const existing = await store.read(context.communityId, captureId, role);
  if (verifyOnly) {
    const accepted = store.same(existing, original);
    const ready = await store.ready(accepted.command_id);
    insist(
      ready && canonical({ ...ready }) === canonical(verifyOnly),
      "dance_publication_original_not_dispatchable",
      409,
    );
  } else if (existing) {
    store.same(existing, original);
    const ready = await store.ready(existing.command_id);
    if (ready) {
      await session.check();
      if (installedStatus) return { commandId: ready.command_id, state: "awaiting_publisher" as const };
      const lookup = selected.actionOriginals;
      const state = lookup
        ? await recoverDanceV2Action({
            store,
            action: existing,
            ready,
            client,
            lookup,
          })
        : "awaiting_publisher";
      await session.check();
      insist(
        lookup === selected.actionOriginals,
        "dance_publication_source_changed",
        409,
      );
      return { commandId: ready.command_id, state };
    }
  }
  web2PublicDanceStart(selected, config, reads);
  const release = catalog.fresh();
  const releaseSource = publicationSelectionSource(release);
  const retained = await store
    .stmt(
      `SELECT c.capture_json,s.consent_json FROM dance_captures c
    JOIN dance_consents s ON s.capture_id=c.capture_id WHERE c.community_id=? AND c.capture_id=?`,
      context.communityId,
      captureId,
    )
    .first<{ capture_json: string; consent_json: string }>();
  insist(retained, "dance_not_found", 404);
  const parsed = parseDanceCaptureV2({
    ...JSON.parse(retained.capture_json),
    consent: JSON.parse(retained.consent_json),
  });
  insist(
    parsed.publication.kind === "publication-bound",
    "dance_not_found",
    404,
  );
  const capture = parsed as PublicationCaptureV2;
  insist(
    capture.canonical.sourceHash === source.sourceHash &&
      canonical(capture.publication.binding.source) ===
        canonical(releaseSource) &&
      capture.expected.ownerEpoch === String(owner.epoch) &&
      capture.expected.configurationRevision ===
        String(config.configurationRevision) &&
      (registration
        ? capture.learner.accountId === actor.accountId
        : capture.learner.accountId !== actor.accountId),
    "dance_publication_action_forbidden",
    403,
  );
  const [wire] = decodeAbiParameters(
    [danceShapes.capture],
    capture.canonical.captureAbi,
  );
  const journal = createDancePublicationJournal(ports, session, Boolean(verification));
  const inputs = {
    db,
    client,
    journal,
    selected: source,
    config,
    caller: publisher,
    owner,
    clock: ports.clock,
    profile: parseWeb2ProfileDocument(release.profile),
    releaseSelectionSha256: releaseSource.releaseSelectionSha256,
  };
  const learner = {
    accountId: capture.learner.accountId,
    binding: capture.publication.binding,
  };
  const fences: DanceFence[] = [
    session.mutationFence({
      db,
      ...actor,
      communityId: context.communityId,
      source: releaseSource,
      active: true,
    }),
    ...(await runtime.publicationV2.current(
      { accountId: learner.accountId },
      capture,
    )),
    {
      sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
        WHERE c.community_id=? AND c.capture_id=? AND c.account_id=? AND c.capture_json=? AND s.consent_json=?)`,
      values: [
        capture.communityId,
        capture.captureId,
        learner.accountId,
        retained.capture_json,
        retained.consent_json,
      ],
    },
  ];
  const repo = runtime.media.ports.repository;
  const prepareReady = (command: DanceV2ReadyCommand) => [
    store.prepare(command),
    ...(pinDispatchSession ? [store.prepareDispatchSession(command, session.original)] : []),
  ];
  function verifyReady(command: DanceV2ReadyCommand, fences: DanceFence[], expiresAtMs: number) {
    insist(
      verifyOnly && canonical(verifyOnly) === canonical(command),
      "dance_publication_original_not_dispatchable",
      409,
    );
    // The private caller joins these unchanged current action fences with the
    // exact ready/original/session in the last primary database operation.
    return {
      commandId: command.command_id,
      state: "awaiting_publisher" as const,
      dispatchAuthority: { fences, expiresAtMs },
    };
  }

  if (registration) {
    const mediaId = danceId(body.mediaId as string),
      recording = bytes32(body.recordingSha256).slice(2);
    const proof = await readDancePublicationAdmission({
      ...inputs,
      original: { kind: "capture", capture: wire, learner },
    });
    const resource = danceSubmissionId(
      source.domain,
      wire.learner,
      wire.captureId,
    );
    const at = {
      address: source.domain.verifier,
      abi: danceVerdictsAbi,
      blockHash: proof.anchor.hash,
      requireCanonical: true,
    } as const;
    const [mediaEpoch, recordingUsed] = await Promise.all([
      client.readContract({ ...at, functionName: "media", args: [resource] }),
      client.readContract({
        ...at,
        functionName: "recordingUsed",
        args: [danceRecordingReplay(source.domain, bytes32("0x" + recording))],
      }),
    ]);
    insist(
      mediaEpoch[0] === 0n && !mediaEpoch[1] && !recordingUsed,
      "dance_publication_registration_changed",
      409,
    );
    const anchor = await client.getBlock({ blockNumber: proof.anchor.number });
    insist(
      anchor.hash === proof.anchor.hash &&
        anchor.timestamp === proof.anchor.timestamp,
      "dance_publication_anchor_changed",
      503,
    );
    fences.push(...proof.fences);
    if (!existing) {
      await runtime.source3.assertSubmission(
        mediaId,
        capture.captureHash,
        "0x" + recording,
      );
      const { witness } = await runtime.media.readyForSubmission(
        mediaId,
        {
          ...actor,
          communityId: capture.communityId,
          songKey: capture.songKey,
          songRevision: capture.songRevision,
          audioSha256: capture.audioSha256.slice(2),
          recordingSha256: recording,
          startSample: capture.startSample,
          durationSamples: capture.durationSamples,
          mediaPolicyVersion: capture.mediaPolicyVersion,
        },
        actor,
      );
      const commitment = danceMediaBinding(
        source.domain,
        capture.captureHash,
        danceMediaId(source.domain, mediaId),
        BigInt(witness.revision + 1),
        bytes32("0x" + recording),
      );
      const media = prepareMediaSubmission(
        repo,
        witness,
        captureId,
        commitment,
        {
          sql: "EXISTS(SELECT 1 FROM dance_v2_action_originals WHERE community_id=? AND capture_id=? AND kind='register' AND account_id=? AND command_id=? AND request_sha256=? AND bound_at_ms>=? AND bound_at_ms<?)",
          values: [
            capture.communityId,
            captureId,
            actor.accountId,
            original.command_id,
            original.request_sha256,
            capture.consent!.acceptedAtMs,
            capture.expiresAtMs,
          ],
        },
      );
      const originalMedia: DanceFence = {
        sql: `EXISTS(SELECT 1 FROM community_media m JOIN dance_source3_requests d
          ON d.community_id=m.community_id AND d.account_id=m.account_id AND d.request_id=m.request_id
          WHERE m.id=? AND m.community_id=? AND m.account_id=? AND m.revision=?
          AND d.capture_id=? AND d.capture_hash=? AND m.state='ready'
          AND json_extract(m.body,'$.recordingSha256')=? AND json_extract(m.body,'$.publicConsent')=0
          AND COALESCE(json_extract(m.body,'$.erasePending'),0)=0)
          AND ${DANCE_DB_NOW}>=? AND ${DANCE_DB_NOW}<?`,
        values: [
          mediaId,
          capture.communityId,
          actor.accountId,
          witness.revision,
          captureId,
          capture.captureHash,
          recording,
          capture.consent!.acceptedAtMs,
          capture.expiresAtMs,
        ],
      };
      const contextHash = acceptanceContext(registrationContext(capture.captureHash, commitment, publisher));
      try {
        await store.atomic(
          [...fences, originalMedia],
          [
            ...media.beforeAcceptance,
            store.reserve(original, contextHash, true),
            ...media.afterAcceptance,
          ],
        );
      } catch (error) {
        if (!(await store.read(context.communityId, captureId, role)))
          throw error;
      }
    }
    const saved = store.same(
      await store.read(context.communityId, captureId, role),
      original,
    );
    const receipt = await mediaSubmissionReceipt(repo, captureId);
    const expectedAcceptance = acceptanceContext(
      registrationContext(capture.captureHash, bytes32(receipt.bindingCommitment), publisher),
    );
    if (installedStatus)
      insist(saved.context_sha256 === expectedAcceptance, "dance_publication_accepting_session_changed", 409);
    if (proof.anchor.timestamp * 1000n < BigInt(receipt.trustedSubmittedAtMs)) {
      await session.check();
      return {
        commandId: saved.command_id,
        state: "awaiting_chain_clock" as const,
      };
    }
    const prepared = registrationCommand(selected, capture, saved, receipt, acceptingSessionPin);
    const command = readyCommand(
      selected,
      prepared.command,
      prepared.submission.submissionId,
    );
    const acceptance = [
      ...fences,
      store.fence(installedStatus ? { ...saved, context_sha256: expectedAcceptance } : saved),
      retainedMediaFence(receipt, recording),
    ];
    if (verifyOnly) {
      await runtime.source3.assertSubmission(
        mediaId,
        capture.captureHash,
        "0x" + recording,
      );
      return verifyReady(command, acceptance, Math.min(receipt.reviewDeadlineMs, proof.expiresAtMs));
    }
    try {
      await store.atomic(acceptance, prepareReady(command));
    } catch (error) {
      const ready = await store.ready(command.command_id);
      if (!ready || canonical(ready) !== canonical(command)) throw error;
      await store.assert(acceptance);
    }
    await session.check();
    return {
      commandId: saved.command_id,
      state: "awaiting_publisher" as const,
    };
  }

  const reviewerCommandId = bytes32(body.publicationCommandId);
  insist(
    body.verdict === "pass" || body.verdict === "not_passed",
    "dance_invalid_verdict",
    400,
  );
  const grantRow = await ownedCommand(db, reviewerCommandId, {
    communityId: context.communityId,
    ...actor,
  });
  insist(
    grantRow.typed_json && grantRow.phase === "accepted",
    "dance_publication_not_recorded",
    403,
  );
  const reviewerGrant = parseCommand(JSON.parse(grantRow.typed_json));
  insist(
    reviewerGrant.action === "grant" &&
      reviewerGrant.commandId === reviewerCommandId &&
      reviewerGrant.message.purpose === "dance-review-attribution" &&
      reviewerGrant.message.learner === session.original.wallet.toLowerCase() &&
      canonical(reviewerGrant.source) === canonical(releaseSource),
    "dance_publication_original_changed",
    403,
  );
  const observedGrant = await journal.reconcileOriginal(reviewerGrant);
  insist(
    observedGrant.state === "recorded",
    "dance_publication_not_recorded",
    403,
  );
  const {
    registered,
    retainedMedia,
    readFences,
    verifyRegistration,
    record: retainedRecord,
  } = await readDanceV2PrivateRegistration(selected, runtime, capture, store);
  fences.push(...readFences);
  const participants = selected.participants;
  insist(participants, "dance_publication_identity_unavailable", 503);
  const pair = structuredClone(participants.pair);
  insist(
    pair[0].accountId === learner.accountId &&
      pair[0].grantId === wire.publicationGrantId &&
      pair[1].accountId === actor.accountId &&
      pair[1].grantId === reviewerGrant.digest &&
      pair[1].wallet === reviewerGrant.message.learner,
    "dance_publication_participants_changed",
    403,
  );
  const privateFences = (
    await participants.privateOriginalFences(structuredClone(pair))
  ).map(validateFence);
  insist(privateFences.length > 0, "dance_publication_fences_missing", 503);
  fences.push(...privateFences);
  const afterAwait = () => store.assert(fences);
  const roles = await readDanceV2ParticipantBindings({
    client,
    selected: source,
    config,
    profile: inputs.profile,
    caller: publisher,
    owner,
    clock: ports.clock,
    participants: pair,
    afterAwait,
    async verifyPrivateOriginals(expected) {
      insist(
        canonical(expected) === canonical(pair),
        "dance_publication_participants_changed",
        409,
      );
      await afterAwait();
    },
  });
  insist(
    roles.participants[0].accountCommitment === wire.accountCommitment &&
      roles.participants[0].groupId === wire.groupId &&
      roles.participants[0].identityEpoch === wire.identityEpoch &&
      roles.participants[0].groupEpoch === wire.groupEpoch,
    "dance_publication_group_changed",
    409,
  );

  const registeredAt = (anchor: DanceBlock) =>
    verifyRegistration(anchor, afterAwait);
  const mediaEpoch = await registeredAt(roles.anchor);
  const reviewer = roles.participants[1];
  const contextHash = hashJson({
    sourceHash: source.sourceHash,
    configurationRevision: config.configurationRevision,
    publisher,
    ownerEpoch: String(owner.epoch),
    captureHash: capture.captureHash,
    registrationHash: registered.command.hash,
    mediaEpoch: String(mediaEpoch),
    grantId: reviewer.grantId,
    accountCommitment: reviewer.accountCommitment,
    groupId: reviewer.groupId,
    identityEpoch: String(reviewer.identityEpoch),
    groupEpoch: String(reviewer.groupEpoch),
    reviewerRoleEpoch: String(roles.reviewerRoleEpoch),
  });
  let action = existing;
  if (!action) {
    try {
      await store.atomic(fences, [store.reserve(original, acceptanceContext(contextHash))]);
    } catch (error) {
      if (!(await store.read(context.communityId, captureId, role)))
        throw error;
    }
    action = await store.read(context.communityId, captureId, role);
  }
  const saved = store.same(action, original);
  insist(
    (installedStatus
      ? saved.context_sha256 === acceptanceContext(contextHash)
      : saved.context_sha256 === contextHash ||
        (verifyOnly && saved.context_sha256 === danceActionAcceptanceContext(contextHash, acceptingSessionPin))),
    "dance_publication_review_context_changed",
    409,
  );
  const boundAt = BigInt(saved.bound_at_ms);
  const decision: DanceDecision = {
    submissionId: registered.submission.submissionId,
    verdict: body.verdict === "pass" ? 1 : 2,
    reviewerAccountCommitment: reviewer.accountCommitment,
    reviewerWallet: reviewer.wallet,
    reviewerPublicationGrantId: reviewer.grantId,
    reviewerIdentityEpoch: reviewer.identityEpoch,
    reviewerGroupId: reviewer.groupId,
    reviewerGroupEpoch: reviewer.groupEpoch,
    expectedOwnerEpoch: owner.epoch,
    expectedReviewerRoleEpoch: roles.reviewerRoleEpoch,
    expectedMediaEpoch: mediaEpoch,
    intentAcceptedAtMs: boundAt,
    expectedConfigurationRevision: BigInt(config.configurationRevision),
    expectedRulesEpoch: 0n,
    reviewerConsentHash: danceReviewerConsent(
      source.domain,
      reviewer.accountCommitment,
      reviewer.wallet,
      source.pin.publicityPolicyHash,
      boundAt,
    ),
  };
  insist(
    saved.bound_at_ms >= retainedMedia.trustedSubmittedAtMs &&
      saved.bound_at_ms < retainedMedia.reviewDeadlineMs,
    "dance_publication_review_expired",
    410,
  );
  const plan = await journal.prepareReview({
    commandId: reviewerCommandId,
    capture: wire,
    decision,
  });
  const admitted = await readDancePublicationAdmission({
    ...inputs,
    original: {
      kind: "review",
      capture: wire,
      decision,
      learner,
      reviewer: plan.grant,
    },
  });
  insist(
    admitted.anchor.timestamp * 1000n >= boundAt,
    "dance_publication_observation_pending",
    503,
  );
  await registeredAt(admitted.anchor);
  const at = {
    address: source.domain.verifier,
    abi: danceVerdictsAbi,
    blockHash: admitted.anchor.hash,
    requireCanonical: true,
  } as const;
  const identities = await Promise.all(
    roles.participants.map(async (participant) => {
      const [identity, group] = await Promise.all([
        client.readContract({
          ...at,
          functionName: "identities",
          args: [participant.accountCommitment],
        }),
        client.readContract({
          ...at,
          functionName: "groups",
          args: [participant.groupId],
        }),
      ]);
      return (
        identity[0].toLowerCase() === participant.wallet &&
        identity[1] === participant.identityEpoch &&
        identity[2] === participant.groupId &&
        identity[3] === participant.groupEpoch &&
        identity[4] &&
        group[0] === participant.groupEpoch &&
        group[1] === 1n &&
        group[4]
      );
    }),
  );
  const anchor = await client.getBlock({ blockNumber: admitted.anchor.number });
  insist(
    identities.every(Boolean) &&
      anchor.hash === admitted.anchor.hash &&
      anchor.timestamp === admitted.anchor.timestamp,
    "dance_publication_review_context_changed",
    409,
  );
  const command = readyCommand(
    selected,
    danceCommand(source.domain, "commitVerdict", publisher, saved.command_id, {
      decision,
    }),
    decision.submissionId,
  );
  const acceptance = [
    ...fences,
    store.fence(installedStatus ? { ...saved, context_sha256: acceptanceContext(contextHash) } : saved),
    ...plan.fences,
    ...admitted.fences,
  ];
  if (verifyOnly) {
    const verdict = await client.readContract({
      ...at,
      functionName: "verdicts",
      args: [decision.submissionId],
    });
    insist(verdict[5] === 0, "dance_publication_verdict_already_recorded", 409);
    await runtime.source3.assertSubmission(
      retainedMedia.mediaId,
      capture.captureHash,
      bytes32("0x" + retainedRecord.recordingSha256),
    );
    return verifyReady(command, [
      ...acceptance,
      {
        sql: `EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=?
          AND capture_hash=? AND account_id=? AND purpose='dance-review-attribution'
          AND command_id=? AND json_extract(value_json,'$.binding')=?)`,
        values: [
          context.communityId,
          captureId,
          capture.captureHash,
          actor.accountId,
          reviewerCommandId,
          canonical(plan.grant.binding),
        ],
      },
    ], Math.min(retainedMedia.reviewDeadlineMs, admitted.expiresAtMs, Number(roles.expiresAtS * 1000n)));
  }
  try {
    await store.atomic(acceptance, [
      ...plan.statements,
      ...prepareReady(command),
    ]);
  } catch (error) {
    const ready = await store.ready(command.command_id);
    if (!ready || canonical(ready) !== canonical(command)) throw error;
    await store.assert(acceptance);
  }
  await session.check();
  return { commandId: saved.command_id, state: "awaiting_publisher" as const };
}
