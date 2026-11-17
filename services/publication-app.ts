import { type Hex, type PublicClient } from "viem";
import { canonical, check } from "../packages/protocol/index.ts";
import { CommunityError, jsonBody } from "../packages/community/common.ts";
import type { AuthContext } from "../packages/community/accounts.ts";
import type { Web2EligibilityPolicy } from "../packages/community/web2-directory-reader.ts";
import {
  publicationPurposes,
  consentDigest,
  consentUint64,
  type PublicationPurpose,
} from "../packages/protocol/publication-consent.ts";
import { publicationConsentTypes } from "../packages/protocol/generated/publication-consent-v1.ts";
import {
  exact,
  parseCommand,
  record,
  signature,
} from "./publication-command-contract.ts";
import {
  acceptCommandSignature,
  beginCommand,
  ownedCommand,
  publicHead,
  savePrepared,
  type CommandRow,
} from "./publication-command-store.ts";
import {
  PublicationRequestSession,
  publicationOriginal,
} from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { publicationDocuments } from "./publication-app-documents.ts";
import { publicationPolicyRead } from "./publication-app-policy.ts";
import {
  publicationObservation,
  publicationRequestOriginal,
  publicationRetainedSource,
} from "./publication-app-journal.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";
import { publicationCurrentState } from "./publication-app-state.ts";
import { publicationPurposeView } from "./publication-app-permission.ts";
import {
  deliverPublicationOriginal,
  propagatePublicationFence,
  reconcilePublicationOriginal,
  type PublicationOutbox,
} from "./publication-app-outbox.ts";

export interface PublicationApplicationPorts extends PublicationOutbox {
  client: PublicClient;
  clock: Web2EligibilityPolicy;
  documentTimeoutMs: number;
  maxDocumentBytes: number;
}
const prefix = "/api/publication-consent/v1/";
const token = (v: unknown) => {
  check(
    typeof v === "string" && /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(v),
    "publication_request_invalid",
  );
  return v;
};
function purposeOf(v: unknown): PublicationPurpose {
  check(
    publicationPurposes.some((p) => p === v),
    "publication_purpose_invalid",
  );
  return v as PublicationPurpose;
}
function nonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return consentDigest(
    "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}
const owner = (s: PublicationRequestSession) => ({
  communityId: s.context.communityId,
  accountId: s.original.account_id,
});
async function view(p: PublicationApplicationPorts, row: CommandRow) {
  const original = publicationOriginal(row, p.catalog),
    head = await publicHead(p.db, row);
  const command = row.typed_json
    ? parseCommand(JSON.parse(row.typed_json))
    : null;
  const observed = await publicationObservation(p.db, row);
  const receipt =
    observed && command ? parsePublicationReceipt(observed, command) : null;
  return {
    commandId: row.command_id,
    sourceId: row.source_id,
    phase: row.phase,
    source: original.source,
    localInhibition: {
      generation: String(head.generation),
      state: head.stopped || head.dirty ? "stopped" : "open",
      operatorFence:
        row.action === "withdraw"
          ? row.fence_ack_json
            ? "acknowledged"
            : "pending"
          : null,
    },
    command,
    receipt,
    publicAdmission: "separate-purpose-and-action-checks",
  };
}
function typedWalletRequest(row: CommandRow) {
  check(row.typed_json, "publication_not_prepared");
  const c = parseCommand(JSON.parse(row.typed_json));
  return {
    domain: {
      name: "Pirate Publication Consent",
      version: "1",
      chainId: c.source.chainId,
      verifyingContract: c.source.registry,
    },
    types: publicationConsentTypes,
    primaryType:
      c.action === "grant" ? "PublicationGrant" : "PublicationWithdrawal",
    message: c.message,
  };
}
async function prepare(
  request: Request,
  p: PublicationApplicationPorts,
  s: PublicationRequestSession,
  action: "grant" | "withdraw",
  stopOnly = false,
) {
  const body = record(await jsonBody(request));
  await s.check();
  exact(
    body,
    action === "withdraw"
      ? ["purpose", "requestId", "sourceId"]
      : ["purpose", "requestId"],
  );
  const purpose = purposeOf(body.purpose),
    requestId = token(body.requestId);
  const requestedSource =
    action === "withdraw" ? consentDigest(body.sourceId) : null;
  let row = await publicationRequestOriginal(p.db, {
    ...owner(s),
    requestId,
    purpose,
    action,
  });
  await s.check();
  if (!row) {
    let release;
    let sourceCommandId: Hex | null = null;
    let originalSubject;
    if (action === "withdraw") {
      const sourceRow = await publicationRetainedSource(p.db, {
        ...owner(s),
        purpose,
        sourceId: requestedSource!,
        bindingId: s.original.binding_id,
        authorId: s.original.author_id,
        learner: s.original.wallet.toLowerCase(),
      });
      await s.check();
      if (!sourceRow)
        throw new CommunityError("publication_source_not_owned", 404);
      sourceCommandId = sourceRow.command_id;
      const original = publicationOriginal(sourceRow, p.catalog);
      release = original.release;
      originalSubject = original.capture;
    } else {
      release = p.catalog.fresh();
      check(release.policies[purpose], "publication_purpose_disabled");
    }
    const capture = originalSubject
      ? { ...originalSubject, sourceCommandId }
      : s.capture(release, sourceCommandId);
    await s.check();
    row = await beginCommand(
      p.db,
      {
        source: publicationSelectionSource(release),
        accountId: s.original.account_id,
        requestId,
        purpose,
        action,
        nonce: nonce(),
        nowMs: p.nowMs(),
        capture: { ...capture },
      },
      s,
    );
    await s.check();
  }
  const original = publicationOriginal(row, p.catalog);
  if (action === "withdraw" && row.source_id !== requestedSource)
    throw new CommunityError("publication_source_not_owned", 404);
  // Local stop is already durable before operator I/O or a wallet challenge.
  if (action === "withdraw") {
    row = await propagatePublicationFence(p, row);
    await s.check();
  }
  if (stopOnly) return s.expose(await view(p, row));
  s.assertOriginal(original.capture);
  const docs =
    action === "grant"
      ? await publicationDocuments(
          original.release,
          purpose,
          s,
          p.documentTimeoutMs,
          p.maxDocumentBytes,
        )
      : null;
  await s.check();
  if (!row.typed_json) {
    const proof = await publicationPolicyRead({
      client: p.client,
      release: original.release,
      learner: original.capture.learner,
      purpose,
      mode: action,
      clock: p.clock,
      session: s,
    });
    await s.check();
    const issued = BigInt(Math.floor(row.created_at / 1000));
    const common = {
      learner: original.capture.learner,
      communityId: original.source.communityId,
      purpose,
      nonce: row.nonce_hex,
    };
    let message;
    if (action === "grant") {
      const d = proof.descriptor;
      check(d, "publication_purpose_disabled");
      const duration = consentUint64(original.release.grantDurationSeconds),
        window = consentUint64(original.release.submitWindowSeconds);
      check(
        duration > 0n &&
          window > 0n &&
          window <= duration &&
          duration <= BigInt(d.maxGrantDurationSeconds) &&
          window <= BigInt(d.maxSubmissionDelaySeconds),
        "publication_release_window_invalid",
      );
      message = {
        ...common,
        publicationTarget: d.target,
        publicationTargetRuntimeHash: d.runtimeHash,
        permissionRevision: d.permissionRevision,
        policyHash: d.policyHash,
        withdrawalEpoch: String(proof.epoch),
        issuedAt: String(issued),
        validAfter: String(issued),
        expiresAt: String(issued + duration),
        submitBefore: String(issued + window),
      };
    } else
      message = {
        ...common,
        expectedEpoch: String(proof.epoch),
        submitBefore: String(
          issued + consentUint64(original.release.withdrawalWindowSeconds),
        ),
      };
    check(
      BigInt(message.submitBefore) > p.clock.now(),
      "publication_original_window_expired",
    );
    // Keep the original issuance time and nonce while safe state catches up.
    // A wallet challenge must not lead straight into a known future-time revert.
    if (action === "grant")
      check(
        proof.anchor.timestamp >= issued,
        "publication_observation_pending",
      );
    await proof.finish();
    await s.check();
    row = await savePrepared(p.db, row, message, row.created_at, s);
    await s.check();
  }
  return s.expose({
    ...(await view(p, row)),
    walletRequest: typedWalletRequest(row),
    documents: docs?.documents ?? null,
  });
}
async function submit(
  request: Request,
  p: PublicationApplicationPorts,
  s: PublicationRequestSession,
  id: Hex,
) {
  const body = record(await jsonBody(request));
  await s.check();
  exact(body, ["signature"]);
  let row = await ownedCommand(p.db, id, owner(s));
  await s.check();
  const original = publicationOriginal(row, p.catalog),
    sig = signature(body.signature);
  check(row.typed_json, "publication_not_prepared");
  const command = parseCommand(JSON.parse(row.typed_json));
  const accepted = { command, signature: sig, fee: original.release.fee };
  check(
    new TextEncoder().encode(canonical(accepted)).length <= 32768,
    "publication_request_too_large",
  );
  if (row.phase !== "accepted") {
    s.assertOriginal(original.capture);
    if (row.action === "grant")
      check(
        p.catalog.active === original.source.releaseSelectionSha256,
        "publication_active_release_changed",
      );
    if (row.action === "withdraw") {
      row = await propagatePublicationFence(p, row);
      await s.check();
    }
    const proof = await publicationPolicyRead({
      client: p.client,
      release: original.release,
      learner: original.capture.learner,
      purpose: command.message.purpose,
      mode: command.action,
      clock: p.clock,
      session: s,
    });
    await s.check();
    check(
      BigInt(command.message.submitBefore) > p.clock.now(),
      "publication_original_window_expired",
    );
    if (command.action === "grant")
      check(
        proof.anchor.timestamp >= BigInt(command.message.issuedAt),
        "publication_observation_pending",
      );
    // Executes the actual EOA/initialized-account contract signature branch
    // against exact calldata from the original message and candidate signature.
    await proof.simulate(command, sig);
    await s.check();
    check(
      BigInt(command.message.submitBefore) > p.clock.now(),
      "publication_original_window_expired",
    );
    row = await acceptCommandSignature(p.db, row, sig, accepted, p.nowMs(), s);
    await s.check();
  } else
    check(
      row.signature === sig && canonical(accepted) === row.accepted_json,
      "publication_command_changed",
    );
  // Durable local acceptance survives response loss. The due scan is the
  // recovery path if this request or an optional wake disappears.
  row = await deliverPublicationOriginal(p, row);
  await s.check();
  return s.expose(await view(p, row));
}
/** Root mounts this BEFORE community-application's generic POST-only /api
 * catchall. First-song supplies catalog.active=null, so fresh grants fail. */
async function publicationApplicationRoute(
  request: Request,
  p: PublicationApplicationPorts,
  context: AuthContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix)) return null;
  const route = url.pathname.slice(prefix.length);
  const session = await PublicationRequestSession.open(request, p.db, context);
  if (route === "capabilities") {
    check(request.method === "GET" && !url.search, "publication_route_invalid");
    const active = p.catalog.active ? p.catalog.get(p.catalog.active) : null;
    return session.expose({
      profile: active ? "publication-consent-v1" : "first-song",
      purposes: active ? Object.keys(active.policies) : [],
      originalRecovery: "retained-source",
      privatePractice: "independent-admission",
      login: "origin-bound-session",
    });
  }
  if (route === "state") {
    check(
      request.method === "GET" &&
        Array.from(url.searchParams.keys()).join() === "purpose",
      "publication_route_invalid",
    );
    return session.expose(
      await publicationPurposeView(
        p,
        session,
        purposeOf(url.searchParams.get("purpose")),
      ),
    );
  }
  const commandRoute = /^commands\/(0x[0-9a-f]{64})(\/submit)?$/.exec(route);
  if (commandRoute) {
    check(!url.search, "publication_route_invalid");
    const id = consentDigest(commandRoute[1]);
    if (commandRoute[2]) {
      check(request.method === "POST", "publication_route_invalid");
      return submit(request, p, session, id);
    }
    check(request.method === "GET", "publication_route_invalid");
    let row = await ownedCommand(p.db, id, owner(session));
    await session.check();
    if (row.phase === "accepted") {
      row = await reconcilePublicationOriginal(p, row);
      await session.check();
    }
    const current = await publicationCurrentState(p, row, session);
    await session.check();
    row = await ownedCommand(p.db, row.command_id, owner(session));
    await session.check();
    return session.expose({ ...(await view(p, row)), currentGrant: current });
  }
  check(request.method === "POST" && !url.search, "publication_route_invalid");
  if (route === "grants/prepare") return prepare(request, p, session, "grant");
  if (route === "withdrawals/prepare")
    return prepare(request, p, session, "withdraw");
  if (route === "withdrawals/stop")
    return prepare(request, p, session, "withdraw", true);
  check(false, "publication_route_invalid");
}
export async function publicationApplicationFetch(
  request: Request,
  p: PublicationApplicationPorts,
  context: AuthContext,
): Promise<Response | null> {
  try {
    return await publicationApplicationRoute(request, p, context);
  } catch (error) {
    if (error instanceof CommunityError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (/^publication_[a-z0-9_]+(?![\s\S])/.test(code)) {
      const status =
        code === "publication_method_invalid"
          ? 405
          : code === "publication_route_invalid"
            ? 404
            : code === "publication_source_ambiguous"
              ? 409
              : code === "publication_observation_pending"
                ? 503
                : /source|chain|anchor|runtime|directory|descriptor|unavailable|missing|timeout|document/.test(
                      code,
                    )
                  ? 503
                  : 409;
      throw new CommunityError(code, status);
    }
    throw new CommunityError("publication_unavailable", 503);
  }
}
