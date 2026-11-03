import { verifyMessage, type Hex } from "viem";
import {
  check,
  digest,
  inputHashes,
  sign,
  verify,
  type Song,
  type Evidence,
  type Signed,
  type Ticket,
  type Result,
} from "../packages/protocol/index.ts";
import { score } from "../packages/scoring/fixture-score.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import { body, call, type Env, type Store } from "./runtime.ts";

export async function operator(
  request: Request,
  env: Env,
  store: Store,
  ctx: DurableObjectState,
) {
  const url = new URL(request.url);
  if (url.pathname === "/admit") {
    const { song } = await body<{ song: Song }>(request);
    check(
      song.communityId === env.COMMUNITY_ID &&
        typeof song.audio === "string" &&
        typeof song.lyrics === "string" &&
        typeof song.title === "string" &&
        typeof song.artwork === "string",
      "invalid_song",
    );
    const jobId = digest({ kind: "admission", song });
    const old = store.get<Signed<Evidence>[]>(`admission:${jobId}`);
    if (old) return Response.json(old);
    await call(env.PAYER, "/reserve", { jobId, ceiling: 2 });
    await call(env.PAYER, "/charge", { jobId, units: 2 });
    const evidence = await Promise.all(
      Object.entries(inputHashes(song)).map(([input, inputHash]) =>
        sign(
          "evidence",
          {
            communityId: song.communityId,
            check: input,
            inputHash,
            outcome: input === "audio" ? "no_match" : "allow",
            expiresAt: store.now() + 3600,
          },
          env.PRIVATE_KEY,
        ),
      ),
    );
    store.set(`admission:${jobId}`, evidence);
    await call(env.PAYER, "/delivered", { jobId });
    return Response.json(evidence);
  }
  if (url.pathname === "/prepare") {
    const record = await body<Signed<Ticket>>(request);
    const ticket = await verify(record, "ticket", env.ISSUER);
    check(
      ticket.communityId === env.COMMUNITY_ID &&
        ticket.operator === env.OPERATOR_ADDRESS &&
        ticket.expiresAt > store.now(),
      "invalid_ticket",
    );
    const old = store.get<Signed<Ticket>>(`ticket:${ticket.ticketId}`);
    if (old) check(digest(old) === digest(record), "ticket_conflict");
    else store.set(`ticket:${ticket.ticketId}`, record);
    return Response.json({ prepared: true });
  }
  if (url.pathname === "/attempt") {
    const ticketId = url.searchParams.get("ticketId") ?? "";
    const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
    check(ticket && ticket.expiresAt > store.now(), "expired_ticket");
    check(
      await verifyMessage({
        address: ticket.sessionKey,
        message: `connect:${ticketId}`,
        signature: url.searchParams.get("proof") as Hex,
      }),
      "wrong_session_key",
    );
    check(
      request.headers.get("Upgrade")?.toLowerCase() === "websocket",
      "upgrade_required",
    );
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ ticketId });
    ctx.acceptWebSocket(pair[1]);
    store.set(
      `attempt:${ticketId}`,
      store.get(`attempt:${ticketId}`) ?? {
        state: "active",
        startedAt: store.now(),
      },
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  return new Response("not_found", { status: 404 });
}
export async function onPerformance(
  ws: WebSocket,
  frame: { words: KaraokeRecognizedWord[]; consumedMs: number },
  env: Env,
  store: Store,
) {
  const { ticketId } = ws.deserializeAttachment() as { ticketId: string };
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)!.body;
  check(ticket.expiresAt > store.now(), "expired_ticket");
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
  check(
    Number.isSafeInteger(frame.consumedMs) &&
      frame.consumedMs > 0 &&
      frame.consumedMs <= 10000,
    "invalid_consumption",
  );
  const units = Math.ceil(frame.consumedMs / 1000);
  check(units <= ticket.ceiling, "ceiling_exceeded");
  const previous = store.get<{ hash: Hex }>(`frame:${ticketId}`);
  check(!previous || previous.hash === digest(frame), "frame_conflict");
  store.set(`frame:${ticketId}`, { hash: digest(frame) });
  const cached = store.get<Signed<Result>>(`result:${ticketId}`);
  if (cached) {
    ws.send(JSON.stringify(cached));
    return;
  }
  const summary = score(frame.words);
  const { charged } = await call<{ charged: number }>(env.PAYER, "/charge", {
    jobId: ticketId,
    units,
  });
  const record = await sign(
    "result",
    {
      attemptId: digest(ticketId),
      ticketId,
      communityId: ticket.communityId,
      participant: ticket.participant,
      songHash: ticket.songHash,
      summary,
      summaryHash: digest(summary),
      endedAt: store.now(),
      charged,
    },
    env.PRIVATE_KEY,
  );
  store.set(`result:${ticketId}`, record);
  store.set(`attempt:${ticketId}`, {
    state: "completed",
    endedAt: store.now(),
  });
  await call(env.PAYER, "/delivered", { jobId: ticketId });
  ws.send(JSON.stringify(record));
}
