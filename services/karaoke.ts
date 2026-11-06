// Operator side of per-line karaoke billing (docs/operator-payments.md 5).
import { verifyMessage, type Hex } from "viem";
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
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import { resultBody, type Attempt } from "./karaoke-result.ts";
import {
  acceptPurchase,
  closeTicketData,
  operatorQuote,
  reconcile,
  redemptionRow,
  refreshRedemptions,
} from "./purchases.ts";
import { dispatch, enqueue, recoverTransactions } from "./operator-tx.ts";
import { acceptConsent, consentRequest, correct, publish } from "./records.ts";
import { body, signatureChainId, type Env, type Store } from "./runtime.ts";

const load = (store: Store, ticketId: string) => {
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
  const manifest = ticket && store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`);
  const attempt = store.get<Attempt>(`attempt:${ticketId}`);
  return { ticket, manifest, attempt };
};
type Status = NonNullable<Attempt["ended"]>["status"];
/**
 * `endedAt` is when the operator decides; `performanceEndedAt` is when singing
 * stopped, which is the disconnect time if the learner never returned.
 */
function end(attempt: Attempt, endedAt: number, status: Status) {
  if (attempt.ended) return;
  const performanceEndedAt =
    attempt.disconnectedAt === null ? endedAt : Math.min(endedAt, attempt.disconnectedAt);
  attempt.ended = {
    endedAt,
    performanceEndedAt,
    status,
    paymentDeadline: endedAt + PAYMENT_GRACE_S,
  };
}
/** For the unpaid-run stop: a purchase received and still being redeemed counts. */
const purchaseReceived = (store: Store, ticketId: Hex, segmentId: string) => {
  const state = redemptionRow(store, unitHash(segmentUnit(ticketId, segmentId, 0)))?.state;
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
  if (!attempt.ended) {
    const events: [number, Status][] = [];
    if (attempt.disconnectedAt !== null)
      events.push([attempt.disconnectedAt + RECONNECT_WINDOW_S, "abandoned"]);
    events.push([
      attempt.startedAt + Math.ceil(songEndMs(manifest) / 1000),
      attempt.connected ? "completed" : "abandoned",
    ]);
    events.push([
      Math.min(ticket.expiresAt, attempt.startedAt + Math.ceil(ticket.maxDurationMs / 1000)),
      "expired",
    ]);
    let run = 0;
    for (const segment of manifest.segments) {
      const segmentEnd = attempt.startedAt + Math.ceil(segment.endMs / 1000);
      if (segmentEnd > now) break;
      run = purchaseReceived(store, ticket.ticketId, segment.segmentId) ? 0 : run + 1;
      if (run >= operatorQuote(env).maxUnpaidRun) {
        events.push([segmentEnd, "payment_missing"]);
        break;
      }
    }
    const due = events.filter(([at]) => at <= now).sort((a, b) => a[0] - b[0])[0];
    if (due) end(attempt, due[0], due[1]);
  }
  if (attempt.ended && now >= attempt.ended.paymentDeadline) attempt.closing = { block: null };
  store.set(`attempt:${ticketId}`, attempt);
  return attempt;
}

/** Closes the ticket on chain, reconciles at the closure block, then signs. */
async function advance(env: Env, store: Store, ticketId: string) {
  const loaded = load(store, ticketId);
  // Purchase state comes from the contract before the stop rule reads it. A
  // failed or slow refresh leaves purchases pending for the next tick; it never
  // blocks timers, capture or finalization.
  if (loaded.ticket && loaded.manifest && loaded.attempt && !loaded.attempt.ended)
    await refreshRedemptions(env, store, loaded.ticket, loaded.manifest).catch(() => undefined);
  const attempt = settle(store, env, ticketId);
  if (!attempt?.closing || attempt.finalized) return;
  const { ticket, manifest } = load(store, ticketId);
  if (!ticket || !manifest) return;
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
  const finalBody = resultBody(store, ticket, manifest, quote, quoteIdOf(quote), current, paid, block);
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
  for (const { key } of store.entries("attempt:")) {
    const ticketId = key.slice("attempt:".length);
    try {
      await advance(env, store, ticketId);
      await publish(env, store, ticketId);
    } catch {
      // Left for the next tick or recovery; one attempt never blocks the rest.
    }
  }
}
/** Recovers unresolved nonces first, so closures behind them can execute. */
export async function recover(env: Env, store: Store) {
  const transactions = await recoverTransactions(env, store);
  await tick(env, store);
  return transactions;
}

/** Accepts a segment purchase for an attempt that is still open for payment. */
async function acceptSegment(env: Env, store: Store, input: SignedPurchase, socketTicketId?: string) {
  const ticketId = input?.purchase?.ticketId;
  return acceptPurchase(env, store, input, { kind: "segment", socketTicketId }, () => {
    const attempt = settle(store, env, ticketId);
    check(attempt && !attempt.closing && !attempt.finalized, "attempt_closed");
  });
}

export async function karaokeRoute(
  request: Request,
  env: Env,
  store: Store,
  ctx: DurableObjectState,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/quote") {
    const quote = operatorQuote(env);
    return Response.json(await sign("quote", quote, env.PRIVATE_KEY, signatureChainId(env)));
  }
  if (url.pathname === "/prepare") {
    const input = await body<{ ticket: Signed<Ticket>; manifest: KaraokeManifest }>(request);
    const ticket = await verify(input.ticket, "ticket", env.ISSUER, signatureChainId(env));
    const quote = operatorQuote(env);
    validateManifest(input.manifest, quote.maxSegmentMs);
    check(
      ticket.operator === env.OPERATOR_ADDRESS &&
        ticket.quoteId === quoteIdOf(quote) &&
        ticket.manifestSha256 === digest(input.manifest) &&
        ticket.expiresAt > store.now(),
      "invalid_ticket",
    );
    const old = store.get<Signed<Ticket>>(`ticket:${ticket.ticketId}`);
    if (old) check(digest(old) === digest(input.ticket), "ticket_conflict");
    store.set(`ticket:${ticket.ticketId}`, input.ticket);
    store.set(`manifest:${ticket.manifestSha256}`, input.manifest);
    return Response.json({ prepared: true });
  }
  if (url.pathname === "/attempt/purchases") {
    const input = await body<SignedPurchase>(request);
    return Response.json({ paid: await acceptSegment(env, store, input) });
  }
  if (url.pathname === "/recover") return Response.json(await recover(env, store));
  if (url.pathname === "/__correct") {
    // Local control, like /__fault: production corrections need an
    // authenticated operator path that does not exist yet.
    // The correction is recorded here; operator ticks publish it.
    const corrected = await correct(env, store, await body<Parameters<typeof correct>[2]>(request));
    return Response.json({ revision: corrected.revision });
  }
  if (url.pathname === "/result") {
    const { ticketId } = await body<{ ticketId: string }>(request);
    await advance(env, store, ticketId);
    const result = store.get(`result:${ticketId}`);
    check(result, "result_not_final");
    return Response.json(result);
  }
  if (url.pathname !== "/attempt") return null;
  const ticketId = url.searchParams.get("ticketId") ?? "";
  await advance(env, store, ticketId);
  const { ticket } = load(store, ticketId);
  check(ticket && ticket.expiresAt > store.now(), "expired_ticket");
  check(
    await verifyMessage({
      address: ticket.sessionKey,
      message: `connect:${ticketId}`,
      signature: url.searchParams.get("proof") as Hex,
    }),
    "wrong_session_key",
  );
  // Read after the await: the relay may have handed words over meanwhile.
  const { attempt } = load(store, ticketId);
  check(!attempt?.ended, "attempt_closed");
  check(request.headers.get("Upgrade")?.toLowerCase() === "websocket", "upgrade_required");
  const resumed = attempt !== undefined;
  // Only the newest connection is live: older sockets for this ticket close,
  // and their later messages or close events are ignored.
  const generation = (attempt?.generation ?? 0) + 1;
  for (const old of ctx.getWebSockets(ticketId)) old.close(4409, "superseded");
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
  store.set(`attempt:${ticketId}`, next);
  if (!resumed)
    store.set(
      `attemptStart:${ticketId}`,
      await sign(
        "attempt_start",
        { ticketId: next.ticketId, attemptId: next.attemptId, startedAt: next.startedAt },
        env.PRIVATE_KEY,
        signatureChainId(env),
      ),
    );
  const pair = new WebSocketPair();
  pair[1].serializeAttachment({ ticketId, generation });
  ctx.acceptWebSocket(pair[1], [ticketId]);
  pair[1].send(
    JSON.stringify({
      type: "ready",
      attemptId: next.attemptId,
      resumed,
      attemptStart: store.get(`attemptStart:${ticketId}`),
      consent: consentRequest(env, store, ticketId, next.attemptId, next.startedAt),
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
export async function onMessage(ws: WebSocket, frame: Frame, env: Env, store: Store) {
  const { ticketId, generation } = ws.deserializeAttachment() as {
    ticketId: string;
    generation: number;
  };
  if (store.get<Attempt>(`attempt:${ticketId}`)?.generation !== generation) {
    ws.send(JSON.stringify({ type: "error", code: "stale_connection" }));
    return;
  }
  if (frame.type === "purchase") {
    await advance(env, store, ticketId);
    try {
      const paid = await acceptSegment(env, store, frame, ticketId);
      ws.send(JSON.stringify({ type: "paid", segmentId: paid.segmentId, take: 0 }));
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
      ws.send(JSON.stringify({ type: "consented", attemptId: attempt.attemptId }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", code: error instanceof Error ? error.message : "invalid_consent" }));
    }
    return;
  }
  // Capture and finish are applied on arrival, after only the synchronous
  // timers, so neither waits on or fails with the payment chain.
  const attempt = settle(store, env, ticketId);
  check(attempt && !attempt.ended, "attempt_closed");
  if (frame.type === "finish") end(attempt, store.now(), "completed");
  else if (frame.type === "provider_failed") {
    // Local simulated provider only: marks lines whose measurement failed.
    check(Array.isArray(frame.lineIds) && frame.lineIds.length <= 100, "protocol_error");
    attempt.failedLineIds = [...new Set([...attempt.failedLineIds, ...frame.lineIds])];
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
  const attempt = ticketId ? store.get<Attempt>(`attempt:${ticketId}`) : undefined;
  // A superseded socket closing never disconnects its replacement.
  if (attempt && !attempt.ended && attempt.generation === generation) {
    attempt.connected = false;
    attempt.disconnectedAt = store.now();
    store.set(`attempt:${ticketId}`, attempt);
  }
}
