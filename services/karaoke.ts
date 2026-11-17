import { checkKaraokeTicketScope, privateKaraokeScope } from "./karaoke-private-profile.ts";
import { privateKaraokeLeaseCurrent, readPrivateKaraokeLease } from "./karaoke-socket-session.ts";
import type { KaraokeRelaySnapshot } from "../packages/karaoke/audio-relay.ts";
import { prepareRecovery } from "./karaoke-prepare-recovery.ts";
import type { KaraokePreparation } from "./karaoke-preparation.ts";
import { recoverLinkedWithdrawals } from "./study-linked-withdrawal-recovery.ts";
import { configuredWithdrawalPorts } from "./study-linked-withdrawal-ports.ts";
import type { LinkedStore } from "./study-linked-withdrawal-contract.ts";
// Operator side of per-line karaoke billing (docs/operator-payments.md 5).
import { verifyMessage, type Hex, type Address } from "viem";
import {
  check,
  digest,
  sign,
  verify,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import {
  quoteIdOf,
  segmentUnit,
  songEndMs,
  unitHash,
  validateManifest,
  PAYMENT_GRACE_S,
  RECONNECT_WINDOW_S,
  type KaraokeManifest,
  type KaraokeResultBody,
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import {
  resultBody,
  INTERNAL_COMPLETION_GRACE_S,
  type Attempt,
} from "./karaoke-result.ts";
import {
  acceptPurchase,
  closeTicketData,
  operatorQuote,
  reconcile,
  redemptionRow,
  refreshRedemptions,
} from "./purchases.ts";
import { dispatch, enqueue } from "./operator-tx.ts";
import {
  acceptConsent,
  consentRequest,
  correct,
  publicationOf,
  publish,
} from "./records.ts";
import { body, signatureChainId } from "./service-call.ts";
import type { Env, Store } from "./runtime.ts";
import { enrollmentForPractice } from "./learning-enrollment.ts";
import {
  authorizationRoute,
  resumeAuthorizations,
} from "./learning-authorization.ts";

import {
  learningEnrollments,
  acceptEnrollment,
  acceptRevocation,
  revocationRequest,
  bindAuthorization,
  bindEnrollment,
  correctV2,
  publicationV2,
  publishV2,
  resumeEnrollments,
  ticketAuthorization,
} from "./learning-results.ts";
import type { Enrollment } from "../packages/protocol/learning-results.ts";
import { sweepLinkedStudyBindings } from "./study-binding-retention.ts";
import { expireStudySpeech } from "./study-operator.ts";
import {
  resumeStudyPublications,
  recoverLearningTransactions,
  settleWithheldLearningTransactions,
} from "./study-publication-recovery.ts";
import {
  enrollmentResultsTarget,
  retainedTarget,
  resultsTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import {
  expireLearnerHistory,
  learnerHistoryDiagnostics,
  saveLearnerHistory,
} from "./learner-history.ts";

/**
 * Learning-results publication applies to this ticket: V2/V3 when configured,
 * or a V4 run, which binds its sign-in authorization whatever else is set.
 */
const learningResultsFor = (env: Env, store: Store, ticketId: string) =>
  !!env.RESULTS_V2_CONTRACT || !!ticketAuthorization(store, ticketId);
const load = (store: Store, ticketId: string) => {
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
  const manifest =
    ticket && store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`);
  const attempt = store.get<Attempt>(`attempt:${ticketId}`);
  return { ticket, manifest, attempt };
};
type Status = NonNullable<Attempt["ended"]>["status"];
// Two 15 s private commit deadlines, with room for seconds rounding.
const PRIVATE_DRAIN_S = 32;
/**
 * `endedAt` is when the operator decides; `performanceEndedAt` is when singing
 * stopped, which is the disconnect time if the learner never returned.
 */
function end(
  attempt: Attempt,
  endedAt: number,
  status: Status,
  nominalEnd = Infinity,
) {
  if (attempt.ended) return;
  const performanceEndedAt = Math.min(
    nominalEnd,
    attempt.disconnectedAt === null
      ? endedAt
      : Math.min(endedAt, attempt.disconnectedAt),
  );
  attempt.ended = {
    endedAt,
    performanceEndedAt,
    status,
    paymentDeadline: Math.min(endedAt, nominalEnd) + PAYMENT_GRACE_S,
  };
}
/** For the unpaid-run stop: a purchase received and still being redeemed counts. */
const purchaseReceived = (store: Store, ticketId: Hex, segmentId: string) => {
  const state = redemptionRow(
    store,
    unitHash(segmentUnit(ticketId, segmentId, 0)),
  )?.state;
  return state === "confirmed" || state === "submitted";
};

/**
 * Synchronous timer evaluation: ends the attempt at the first terminal event
 * that has occurred, and marks it closing once the payment deadline passes.
 */
export function settle(store: Store, env: Env, ticketId: string) {
  const { ticket, manifest, attempt } = load(store, ticketId);
  if (!ticket || !manifest || !attempt || attempt.closing) return attempt;
  const now = store.now();
  const nominalEnd = attempt.startedAt + Math.ceil(songEndMs(manifest) / 1000);
  const internal = env.SERVICE_MODE === "internal";
  const completionGrace = ticket.privateProfileHash ? 15 : INTERNAL_COMPLETION_GRACE_S;
  if (!attempt.ended) {
    const events: [number, Status][] = [];
    if (attempt.disconnectedAt !== null)
      events.push([attempt.disconnectedAt + RECONNECT_WINDOW_S, "abandoned"]);
    const completed =
      attempt.connected ||
      (internal &&
        attempt.disconnectedAt !== null &&
        attempt.disconnectedAt >= nominalEnd);
    events.push([
      nominalEnd + (internal && completed ? completionGrace : 0),
      completed ? "completed" : "abandoned",
    ]);
    events.push([
      Math.min(
        ticket.expiresAt,
        attempt.startedAt + Math.ceil(ticket.maxDurationMs / 1000),
      ),
      "expired",
    ]);
    let run = 0;
    for (const segment of env.SERVICE_MODE === "internal"
      ? []
      : manifest.segments) {
      const segmentEnd = attempt.startedAt + Math.ceil(segment.endMs / 1000);
      if (segmentEnd > now) break;
      run = purchaseReceived(store, ticket.ticketId, segment.segmentId)
        ? 0
        : run + 1;
      if (run >= operatorQuote(env).maxUnpaidRun) {
        events.push([segmentEnd, "payment_missing"]);
        break;
      }
    }
    const due = events
      .filter(([at]) => at <= now)
      .sort((a, b) => a[0] - b[0])[0];
    // Allow the last 100 ms capture frame and transport delay to arrive, but
    // never move the public cutoff or extend expiry or the payment deadline.
    if (due) end(attempt, due[0], due[1], internal ? nominalEnd : Infinity);
  }
  if (attempt.ended && now >= attempt.ended.paymentDeadline) {
    const relay = ticket.privateProfileHash
      ? store.get<KaraokeRelaySnapshot>("audioRelay:" + ticketId)
      : undefined;
    const unresolved = !!relay && (
      (relay.lastAudioEndMs ?? 0) > (relay.resolvedThroughMs ?? 0) ||
      relay.forwardedWords < relay.words.length
    );
    const drain = attempt.privateDrain;
    const holding = !!ticket.privateProfileHash && (
      drain ? !drain.settled && now < drain.until
        : unresolved && now < Math.min(ticket.expiresAt, attempt.ended.endedAt + PRIVATE_DRAIN_S)
    );
    if (!holding) attempt.closing = { block: null };
  }
  store.set(`attempt:${ticketId}`, attempt);
  return attempt;
}

/** Freeze the accepted EOS before waiting for any provider callback. The
 * inherited nominal/expiry decision, when already recorded, stays authoritative. */
export function beginPrivateKaraokeDrain(
  store: Store, env: Env, ticketId: string, generation: number,
): number | null {
  const { ticket, manifest } = load(store, ticketId);
  const attempt = settle(store, env, ticketId);
  if (!ticket?.privateProfileHash || !manifest || !attempt || attempt.closing ||
      !attempt.connected || attempt.generation !== generation)
    return null;
  if (attempt.privateDrain) return null;
  const now = store.now();
  const nominal = attempt.startedAt + Math.ceil(songEndMs(manifest) / 1000);
  const until = Math.min(ticket.expiresAt, nominal + 50, now + PRIVATE_DRAIN_S);
  if (until <= now) return null;
  end(attempt, now, "completed", nominal);
  attempt.privateDrain = { generation, until, settled: false };
  store.set("attempt:" + ticketId, attempt);
  return until;
}

export function completePrivateKaraokeDrain(
  store: Store, env: Env, ticketId: string, generation: number,
): boolean {
  const { ticket, attempt } = load(store, ticketId);
  const drain = attempt?.privateDrain;
  if (!ticket?.privateProfileHash || !attempt || attempt.closing ||
      !drain || drain.settled || drain.generation !== generation ||
      attempt.generation !== generation || store.now() >= drain.until)
    return false;
  drain.settled = true;
  store.set("attempt:" + ticketId, attempt);
  settle(store, env, ticketId);
  return true;
}

/** Closes the ticket on chain, reconciles at the closure block, then signs. */
async function advance(env: Env, store: Store, ticketId: string) {
  const loaded = load(store, ticketId);
  // Purchase state comes from the contract before the stop rule reads it. A
  // failed or slow refresh leaves purchases pending for the next tick; it never
  // blocks timers, capture or finalization.
  if (
    env.SERVICE_MODE !== "internal" &&
    loaded.ticket &&
    loaded.manifest &&
    loaded.attempt &&
    !loaded.attempt.ended
  )
    await refreshRedemptions(env, store, loaded.ticket, loaded.manifest).catch(
      () => undefined,
    );
  const attempt = settle(store, env, ticketId);
  if (!attempt?.closing || attempt.finalized) return;
  const { ticket, manifest } = load(store, ticketId);
  if (!ticket || !manifest) return;
  const scope = privateKaraokeScope(env, store);
  checkKaraokeTicketScope(ticket, scope);
  if (env.SERVICE_MODE === "internal") {
    const current = store.get<Attempt>(`attempt:${ticketId}`)!;
    const quote = operatorQuote(env);
    const result = resultBody(
      store,
      ticket,
      manifest,
      quote,
      quoteIdOf(quote),
      current,
      new Map(),
      0,
    );
    const signed = await sign(
      "result",
      result,
      env.PRIVATE_KEY,
      signatureChainId(env),
    );
    store.transaction(() => {
      if (store.get<Attempt>(`attempt:${ticketId}`)?.finalized) return;
      store.set(`result:${ticketId}`, signed);
      saveLearnerHistory(
        store,
        result,
        manifest,
        Number(env.HISTORY_RETENTION_DAYS),
        scope ? { name: "whisper.cpp-local", model: "base.en-q5_1", modelSha256: scope.modelSha256,
          timing: "whisper-token-timestamps" } : undefined,
      );
      store.set(`attempt:${ticketId}`, { ...current, finalized: true });
    });
    return;
  }
  // The closure is an intent like any redemption: persisted first, sent once.
  enqueue(
    store,
    "close",
    ticketId,
    operatorQuote(env).payments,
    closeTicketData(ticket.community, ticket.ticketId),
    // MegaETH testnet measured 110,022, above the former 100,000 limit.
    300_000n,
  );
  const close = await dispatch(env, store, "close", ticketId);
  if (!close?.mined) return;
  check(close.mined.status === "success", "closure_reverted");
  const block = close.mined.block;
  const paid = await reconcile(env, ticket, manifest, block);
  const current = store.get<Attempt>(`attempt:${ticketId}`)!;
  if (current.finalized) return;
  if (store.get("fault:crash-before-result")) {
    store.delete("fault:crash-before-result");
    throw new Error("simulated_crash_before_result");
  }
  const quote = operatorQuote(env);
  const finalBody = resultBody(
    store,
    ticket,
    manifest,
    quote,
    quoteIdOf(quote),
    current,
    paid,
    block,
  );
  store.set(
    `result:${ticketId}`,
    await sign("result", finalBody, env.PRIVATE_KEY, signatureChainId(env)),
  );
  store.set(`attempt:${ticketId}`, {
    ...current,
    closing: { ...current.closing!, block },
    finalized: true,
  });
}
export async function tick(env: Env, store: Store) {
  if (privateKaraokeScope(env, store)) {
    expireLearnerHistory(store);
    for (const { key } of store.entries("attempt:"))
      await advance(env, store, key.slice("attempt:".length));
    return;
  }
  if (env.RESULTS_V4_CONTRACT)
    await recoverLinkedWithdrawals(
      store,
      configuredWithdrawalPorts(env, store as LinkedStore),
    );
  expireLearnerHistory(store);
  expireStudySpeech(store);
  await sweepLinkedStudyBindings(env, store).catch(() => undefined);
  if (env.RESULTS_V3_CONTRACT || env.RESULTS_V4_CONTRACT)
    await resumeStudyPublications(env, store);
  if (env.RESULTS_V2_CONTRACT) await resumeEnrollments(env, store);
  if (env.RESULTS_V4_CONTRACT) await resumeAuthorizations(env, store);
  for (const { key } of store.entries("attempt:")) {
    const ticketId = key.slice("attempt:".length);
    try {
      await advance(env, store, ticketId);
      if (learningResultsFor(env, store, ticketId))
        await publishV2(env, store, ticketId);
      else await publish(env, store, ticketId);
    } catch {
      // Left for the next tick or recovery; one attempt never blocks the rest.
    }
  }
  // Withheld result transactions: pending cancellations and nonces the
  // chain shows consumed. Each waiting state is logged.
  await settleWithheldLearningTransactions(env, store);
}
/** Recovers unresolved nonces first, so closures behind them can execute. */
export async function recover(env: Env, store: Store) {
  if (privateKaraokeScope(env, store)) {
    await tick(env, store);
    return [];
  }
  if (env.RESULTS_V4_CONTRACT)
    await recoverLinkedWithdrawals(
      store,
      configuredWithdrawalPorts(env, store as LinkedStore),
    );
  const transactions = await recoverLearningTransactions(env, store);
  await tick(env, store);
  return transactions;
}

/** Accepts a segment purchase for an attempt that is still open for payment. */
async function acceptSegment(
  env: Env,
  store: Store,
  input: SignedPurchase,
  socketTicketId?: string,
) {
  const ticketId = input?.purchase?.ticketId;
  return acceptPurchase(
    env,
    store,
    input,
    { kind: "segment", socketTicketId },
    () => {
      const attempt = settle(store, env, ticketId);
      check(
        attempt && !attempt.closing && !attempt.finalized,
        "attempt_closed",
      );
    },
  );
}

export async function karaokeRoute(
  request: Request,
  env: Env,
  store: Store,
  ctx: DurableObjectState,
): Promise<Response | null> {
  const url = new URL(request.url);
  const privateScope = privateKaraokeScope(env, store);
  if (privateScope && !["/history", "/quote", "/prepare", "/attempt-start", "/record", "/result", "/attempt"].includes(url.pathname))
    return new Response("not_found", { status: 404 });
  if (url.pathname === "/history" && env.SERVICE_MODE === "internal") {
    const { ticketId, proof } = await body<{ ticketId: string; proof: Hex }>(
      request,
    );
    const { ticket } = load(store, ticketId);
    check(
      ticket &&
        (await verifyMessage({
          address: ticket.sessionKey,
          message: `connect:${ticketId}`,
          signature: proof,
        })),
      "history_not_found",
    );
    checkKaraokeTicketScope(ticket, privateScope);
    expireLearnerHistory(store);
    const history = store.get<Record<string, unknown>>(`history:${ticketId}`);
    check(history, "history_not_found");
    return Response.json({
      ...history,
      diagnostics: learnerHistoryDiagnostics(store, ticketId),
    });
  }
  const authorization = privateScope ? null : await authorizationRoute(request, env, store);
  if (authorization) return authorization;
  if (url.pathname === "/enrollment/list") {
    const { learner } = await body<{ learner: Address }>(request);
    return Response.json(await learningEnrollments(env, store, learner));
  }
  if (url.pathname === "/enrollment/request") {
    check(env.RESULTS_V2_CONTRACT, "results_unconfigured");
    const { learner, target, activity } = await body<{
      learner: Address;
      target?: ResultsTarget;
      activity?: "study";
    }>(request);
    check(
      activity === undefined || activity === "study",
      "unsupported_activity",
    );
    const destination = target
      ? retainedTarget(env, target)
      : activity === "study"
        ? resultsTarget(env, 3)
        : enrollmentResultsTarget(env);
    return Response.json(
      await enrollmentForPractice(
        env,
        store,
        learner,
        destination,
        activity === "study" ? 2 : 1,
      ),
    );
  }
  if (url.pathname === "/enrollment/revoke") {
    const { learner, nonce, signature, target } = await body<{
      learner: Address;
      nonce?: string;
      signature?: Hex;
      target?: ResultsTarget;
    }>(request);
    const destination = target
      ? retainedTarget(env, target)
      : enrollmentResultsTarget(env);
    if (!signature)
      return Response.json(await revocationRequest(env, learner, destination));
    check(nonce !== undefined, "nonce_required");
    const row = await acceptRevocation(
      env,
      store,
      learner,
      BigInt(nonce),
      signature,
      destination,
    );
    return Response.json({ state: row?.mined?.status ?? "pending" });
  }
  if (url.pathname === "/enrollment") {
    const {
      enrollment: input,
      signature,
      target,
    } = await body<{
      enrollment: Record<string, string>;
      signature: Hex;
      target?: ResultsTarget;
    }>(request);
    const enrollment: Enrollment = {
      learner: input.learner as Address,
      communityId: input.communityId as Hex,
      publicityPolicy: input.publicityPolicy as Hex,
      activities: BigInt(input.activities),
      expiresAt: BigInt(input.expiresAt),
      nonce: BigInt(input.nonce),
    };
    const row = await acceptEnrollment(
      env,
      store,
      enrollment,
      signature,
      target ? retainedTarget(env, target) : enrollmentResultsTarget(env),
    );
    return Response.json({ state: row?.mined?.status ?? "pending" });
  }
  if (url.pathname === "/quote") {
    const quote = operatorQuote(env);
    return Response.json(
      await sign("quote", quote, env.PRIVATE_KEY, signatureChainId(env)),
    );
  }
  if (url.pathname === "/prepare") {
    const input = await body<{
      ticket: Signed<Ticket>;
      manifest: KaraokeManifest;
      preparation?: KaraokePreparation;
    }>(request);
    if (input.preparation) {
      check(!privateScope && input.ticket.body.privateProfileHash === undefined,
        "private_karaoke_ticket_scope_changed");
      return Response.json(
        await prepareRecovery(env, store, {
          ...input,
          preparation: input.preparation,
        }),
      );
    }
    const ticket = await verify(
      input.ticket,
      "ticket",
      env.ISSUER,
      signatureChainId(env),
    );
    checkKaraokeTicketScope(ticket, privateScope);
    if (privateScope) check(ticket.communityId === env.COMMUNITY_ID &&
      ticket.community.toLowerCase() === env.COMMUNITY_ADDRESS?.toLowerCase() &&
      ticket.issuedAt <= store.now(), "private_karaoke_ticket_scope_changed");
    const quote = operatorQuote(env);
    validateManifest(input.manifest, quote.maxSegmentMs);
    check(
      ticket.operator.toLowerCase() === env.OPERATOR_ADDRESS.toLowerCase() &&
        ticket.quoteId === quoteIdOf(quote) &&
        ticket.manifestSha256 === digest(input.manifest) &&
        ticket.songHash === input.manifest.songHash &&
        ticket.expiresAt > store.now(),
      "invalid_ticket",
    );
    const old = store.get<Signed<Ticket>>(`ticket:${ticket.ticketId}`);
    if (old) check(digest(old) === digest(input.ticket), "ticket_conflict");
    // A V4 ticket names the learner's sign-in authorization; V2/V3 tickets
    // bind the learner's enrollment as before.
    if (ticket.authorizationId !== undefined)
      await bindAuthorization(
        env,
        store,
        ticket.ticketId,
        ticket.participant,
        ticket.authorizationId,
      );
    else if (env.RESULTS_V2_CONTRACT)
      await bindEnrollment(env, store, ticket.ticketId, ticket.participant);
    store.transaction(() => {
      store.set("ticket:" + ticket.ticketId, input.ticket);
      store.set("manifest:" + ticket.manifestSha256, input.manifest);
    });
    return Response.json({ prepared: true });
  }
  if (url.pathname === "/attempt/purchases") {
    const input = await body<SignedPurchase>(request);
    return Response.json({ paid: await acceptSegment(env, store, input) });
  }
  if (url.pathname === "/recover")
    return Response.json(await recover(env, store));
  if (url.pathname === "/__correct") {
    // Local control, like /__fault: production corrections need an
    // authenticated operator path that does not exist yet.
    // The correction is recorded here; operator ticks publish it.
    const input = await body<Parameters<typeof correct>[2]>(request);
    const corrected = await (
      learningResultsFor(env, store, input.ticketId) ? correctV2 : correct
    )(env, store, input);
    return Response.json({ revision: corrected.revision });
  }
  if (url.pathname === "/consent") {
    // The same consent the socket accepts, for a learner whose attempt has
    // ended or whose socket closed: only the learner's signature is accepted.
    const input = await body<{ ticketId: string; signature: Hex }>(request);
    const attempt = store.get<Attempt>(`attempt:${input.ticketId}`);
    check(attempt, "attempt_not_found");
    await acceptConsent(env, store, input.ticketId, attempt, input.signature);
    return Response.json({ consented: true, attemptId: attempt.attemptId });
  }
  if (url.pathname === "/attempt-start" && env.SERVICE_MODE === "internal") {
    const { ticketId } = await body<{ ticketId: string }>(request);
    return Response.json(store.get(`attemptStart:${ticketId}`) ?? null);
  }
  if (url.pathname === "/record") {
    // What the learner's screen shows about the on-chain record.
    const { ticketId } = await body<{ ticketId: string }>(request);
    const attempt = store.get<Attempt>(`attempt:${ticketId}`);
    check(attempt, "attempt_not_found");
    if (privateScope) {
      const { ticket } = load(store, ticketId);
      check(ticket, "attempt_not_found");
      checkKaraokeTicketScope(ticket, privateScope);
      return Response.json({ consented: false, consent: null, publication: { state: "private" } });
    }
    if (learningResultsFor(env, store, ticketId))
      return Response.json({
        consented: true,
        consent: null,
        publication: publicationV2(store, ticketId) ?? null,
      });
    return Response.json({
      attemptId: attempt.attemptId,
      consented: store.get(`consent:${ticketId}`) !== undefined,
      // The same request the socket's ready message offers, for a reload.
      consent:
        consentRequest(
          env,
          store,
          ticketId,
          attempt.attemptId,
          attempt.startedAt,
        ) ?? null,
      publication: publicationOf(store, ticketId) ?? null,
    });
  }
  if (url.pathname === "/result") {
    const { ticketId } = await body<{ ticketId: string }>(request);
    await advance(env, store, ticketId);
    const result = store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`);
    check(result, "result_not_final");
    // Enrich older private receipts for display without revising public grades.
    if (
      !result.body.presentation &&
      env.SERVICE_MODE === "internal" &&
      store.get(`words:${ticketId}`)
    ) {
      const { ticket, manifest, attempt } = load(store, ticketId);
      if (ticket && manifest && attempt?.ended) {
        const quote = operatorQuote(env);
        const enriched = resultBody(
          store,
          ticket,
          manifest,
          quote,
          quoteIdOf(quote),
          attempt,
          new Map(),
          result.body.closedAtBlock,
        );
        return Response.json({
          ...result,
          presentation: enriched.presentation,
        });
      }
    }
    return Response.json(result);
  }
  if (url.pathname !== "/attempt") return null;
  const ticketId = url.searchParams.get("ticketId") ?? "";
  if (!privateScope) await advance(env, store, ticketId);
  const { ticket } = load(store, ticketId);
  check(ticket && ticket.expiresAt > store.now(), "expired_ticket");
  checkKaraokeTicketScope(ticket, privateScope);
  const browserLease = privateScope ? readPrivateKaraokeLease(request.headers) : undefined;
  if (privateScope) check(
    env.KARAOKE_LOCAL_BROWSER_ORIGIN && env.KARAOKE_LOCAL_INGRESS &&
      request.headers.get("origin") === env.KARAOKE_LOCAL_BROWSER_ORIGIN &&
      request.headers.get("x-pirate-local-karaoke-ingress") === env.KARAOKE_LOCAL_INGRESS &&
      browserLease?.account === ticket.participant.toLowerCase(),
    "private_karaoke_socket_authority_changed",
  );
  check(
    await verifyMessage({
      address: ticket.sessionKey,
      message: `connect:${ticketId}`,
      signature: url.searchParams.get("proof") as Hex,
    }),
    "wrong_session_key",
  );
  if (privateScope) {
    check(await privateKaraokeLeaseCurrent(env, browserLease), "private_karaoke_socket_authority_changed");
    await advance(env, store, ticketId);
  }
  // Read after the await: the relay may have handed words over meanwhile.
  const { attempt } = load(store, ticketId);
  check(!attempt?.ended, "attempt_closed");
  check(
    request.headers.get("Upgrade")?.toLowerCase() === "websocket",
    "upgrade_required",
  );
  const resumed = attempt !== undefined;
  // A new run re-checks its binding when it starts: a V4 run its sign-in
  // authorization, a V2/V3 run its enrollment.
  if (!resumed && ticket.authorizationId !== undefined)
    await bindAuthorization(
      env,
      store,
      ticketId,
      ticket.participant,
      ticket.authorizationId,
    );
  else if (env.RESULTS_V2_CONTRACT && !resumed)
    await bindEnrollment(env, store, ticketId, ticket.participant);
  // Only the newest connection is live: older sockets for this ticket close,
  // and their later messages or close events are ignored.
  const generation = (attempt?.generation ?? 0) + 1;
  const next: Attempt = attempt
    ? { ...attempt, connected: true, disconnectedAt: null, generation }
    : {
        ticketId: ticket.ticketId,
        attemptId: digest(ticket.ticketId),
        startedAt: store.now(),
        connected: true,
        disconnectedAt: null,
        lastAudioAt: null,
        failedLineIds: [],
        ended: null,
        closing: null,
        finalized: false,
        generation,
      };
  const retainSocketAttempt = () => {
    for (const old of ctx.getWebSockets(ticketId)) old.close(4409, "superseded");
    store.set("attempt:" + ticketId, next);
  };
  if (!privateScope) retainSocketAttempt();
  const start = !resumed
    ? await sign(
        "attempt_start",
        {
          ticketId: next.ticketId,
          attemptId: next.attemptId,
          startedAt: next.startedAt,
        },
        env.PRIVATE_KEY,
        signatureChainId(env),
      )
    : undefined;
  if (privateScope) {
    check(await privateKaraokeLeaseCurrent(env, browserLease), "private_karaoke_socket_authority_changed");
    const current = load(store, ticketId).attempt;
    check(current?.generation === attempt?.generation && !current?.ended &&
      store.now() < ticket.expiresAt, "karaoke_socket_generation_changed");
    if (current) Object.assign(next, current, { connected: true, disconnectedAt: null, generation });
    retainSocketAttempt();
  }
  if (start) store.set("attemptStart:" + ticketId, start);
  const pair = new WebSocketPair();
  pair[1].serializeAttachment({ ticketId, generation, ...(browserLease ? { browserLease } : {}) });
  ctx.acceptWebSocket(pair[1], [ticketId]);
  pair[1].send(
    JSON.stringify({
      type: "ready",
      attemptId: next.attemptId,
      resumed,
      audioSequence:
        store.get<{ lastSequence: number | null }>(`audioRelay:${ticketId}`)
          ?.lastSequence ?? 0,
      attemptStart: store.get(`attemptStart:${ticketId}`),
      feedback: store.get(`feedback:${ticketId}`) ?? null,
      consent: privateScope ? undefined : consentRequest(
        env,
        store,
        ticketId,
        next.attemptId,
        next.startedAt,
      ),
    }),
  );
  return new Response(null, { status: 101, webSocket: pair[0] });
}

type Frame =
  | ({ type: "purchase" } & SignedPurchase)
  | { type: "words"; words: KaraokeRecognizedWord[] }
  | { type: "provider_failed"; lineIds: string[] }
  | { type: "finish" }
  | { type: "consent"; signature: Hex };
export async function onMessage(
  ws: WebSocket,
  frame: Frame,
  env: Env,
  store: Store,
) {
  const { ticketId, generation } = ws.deserializeAttachment() as {
    ticketId: string;
    generation: number;
  };
  if (store.get<Attempt>(`attempt:${ticketId}`)?.generation !== generation) {
    ws.send(JSON.stringify({ type: "error", code: "stale_connection" }));
    return;
  }
  const scope = privateKaraokeScope(env, store);
  if (scope) {
    const { ticket } = load(store, ticketId);
    check(ticket, "attempt_not_found");
    checkKaraokeTicketScope(ticket, scope);
    check(frame.type === "finish", "private_karaoke_frame_unavailable");
  }
  if (frame.type === "purchase") {
    await advance(env, store, ticketId);
    try {
      const paid = await acceptSegment(env, store, frame, ticketId);
      ws.send(
        JSON.stringify({ type: "paid", segmentId: paid.segmentId, take: 0 }),
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: error instanceof Error ? error.message : "invalid_purchase",
        }),
      );
    }
    return;
  }
  if (frame.type === "consent") {
    // Accepted at any point on the live socket, even after the attempt ends.
    const attempt = store.get<Attempt>(`attempt:${ticketId}`)!;
    try {
      await acceptConsent(env, store, ticketId, attempt, frame.signature);
      ws.send(
        JSON.stringify({ type: "consented", attemptId: attempt.attemptId }),
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: error instanceof Error ? error.message : "invalid_consent",
        }),
      );
    }
    return;
  }
  // Capture and finish are applied on arrival, after only the synchronous
  // timers, so neither waits on or fails with the payment chain.
  const attempt = settle(store, env, ticketId);
  check(attempt && !attempt.ended, "attempt_closed");
  if (frame.type === "finish") {
    const { manifest } = load(store, ticketId);
    check(manifest, "manifest_missing");
    end(
      attempt,
      store.now(),
      "completed",
      env.SERVICE_MODE === "internal"
        ? attempt.startedAt + Math.ceil(songEndMs(manifest) / 1000)
        : Infinity,
    );
  } else if (frame.type === "provider_failed") {
    // Local simulated provider only: marks lines whose measurement failed.
    check(
      Array.isArray(frame.lineIds) && frame.lineIds.length <= 100,
      "protocol_error",
    );
    attempt.failedLineIds = [
      ...new Set([...attempt.failedLineIds, ...frame.lineIds]),
    ];
  } else if (frame.type === "words") {
    check(
      Array.isArray(frame.words) &&
        frame.words.length <= 100 &&
        frame.words.every(
          (w) =>
            typeof w.text === "string" &&
            Number.isFinite(w.startMs) &&
            Number.isFinite(w.endMs) &&
            w.startMs >= 0 &&
            w.endMs >= w.startMs,
        ),
      "invalid_words",
    );
    const words = store.get<KaraokeRecognizedWord[]>(`words:${ticketId}`) ?? [];
    check(words.length + frame.words.length <= 2000, "too_many_words");
    store.set(`words:${ticketId}`, [...words, ...frame.words]);
    attempt.lastAudioAt = store.now();
  } else throw new Error("protocol_error");
  store.set(`attempt:${ticketId}`, attempt);
  await advance(env, store, ticketId).catch(() => undefined);
}
export function onClose(ws: WebSocket, store: Store) {
  const { ticketId, generation } = (ws.deserializeAttachment() ?? {}) as {
    ticketId?: string;
    generation?: number;
  };
  const attempt = ticketId
    ? store.get<Attempt>(`attempt:${ticketId}`)
    : undefined;
  // A superseded socket closing never disconnects its replacement.
  if (attempt && !attempt.ended && attempt.generation === generation) {
    attempt.connected = false;
    attempt.disconnectedAt = store.now();
    store.set(`attempt:${ticketId}`, attempt);
  }
}
