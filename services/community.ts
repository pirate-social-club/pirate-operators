import { createSiweMessage } from "viem/siwe";
import { verifyMessage, isAddress, type Address, type Hex } from "viem";
import {
  check,
  digest,
  gate,
  inputHashes,
  sign,
  verify,
  type Song,
  type Evidence,
  type Signed,
  type Ticket,
  type Result,
} from "../packages/protocol/index.ts";
import { body, call, type Env, type Store } from "./runtime.ts";

export async function community(request: Request, env: Env, store: Store) {
  const path = new URL(request.url).pathname;
  if (path === "/challenge") {
    const { wallet } = await body<{ wallet: Address }>(request);
    check(isAddress(wallet), "invalid_wallet");
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const message = createSiweMessage({
      address: wallet,
      chainId: 31337,
      domain: env.COMMUNITY_DOMAIN,
      uri: `http://${env.COMMUNITY_DOMAIN}`,
      version: "1",
      nonce,
      issuedAt: new Date(store.now() * 1000),
      statement: "Sign in to the local Pirate community.",
    });
    store.set(`nonce:${nonce}`, {
      message,
      wallet,
      expires: store.now() + 300,
    });
    return Response.json({ message, nonce });
  }
  if (path === "/session") {
    const { nonce, signature } = await body<{ nonce: string; signature: Hex }>(
      request,
    );
    const key = `nonce:${nonce}`;
    const challenge = store.get<{
      message: string;
      wallet: Address;
      expires: number;
    }>(key);
    check(challenge && challenge.expires > store.now(), "invalid_nonce");
    check(
      await verifyMessage({
        address: challenge.wallet,
        message: challenge.message,
        signature,
      }),
      "invalid_login",
    );
    check(store.get(key), "nonce_replayed");
    store.delete(key);
    const token = crypto.randomUUID();
    store.set(`session:${token}`, {
      wallet: challenge.wallet,
      expires: store.now() + 86400,
    });
    return Response.json({ token });
  }
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const session = token
    ? store.get<{ wallet: Address; expires: number }>(`session:${token}`)
    : undefined;
  check(session && session.expires > store.now(), "session_required");
  if (path === "/songs") {
    const song = await body<Song>(request);
    check(song.communityId === env.COMMUNITY_ID, "wrong_community");
    const songHash = digest(song);
    const evidence = await call<Signed<Evidence>[]>(env.OPERATOR, "/admit", {
      song,
    });
    const records = await Promise.all(
      evidence.map((record) =>
        verify(record, "evidence", env.OPERATOR_ADDRESS),
      ),
    );
    const status = gate(song, records, store.now());
    store.set(`song:${songHash}`, { song, status, evidence });
    return Response.json({ songHash, status, hashes: inputHashes(song) });
  }
  if (path === "/tickets") {
    const { songHash, sessionKey } = await body<{
      songHash: Hex;
      sessionKey: Address;
    }>(request);
    check(isAddress(sessionKey), "invalid_session_key");
    check(
      store.get<{ status: string }>(`song:${songHash}`)?.status === "published",
      "unpublished_song",
    );
    check(store.now() < Number(env.CUTOFF), "entry_closed");
    const ticketId = digest({
      community: env.COMMUNITY_ID,
      participant: session.wallet,
      songHash,
    });
    const previous = store.get<Signed<Ticket>>(`ticket:${ticketId}`);
    if (previous) {
      check(previous.body.sessionKey === sessionKey, "different_session_key");
      return Response.json(previous);
    }
    await call(env.PAYER, "/reserve", { jobId: ticketId, ceiling: 10 });
    const ticket = await sign(
      "ticket",
      {
        ticketId,
        communityId: env.COMMUNITY_ID,
        participant: session.wallet,
        songHash,
        sessionKey,
        operator: env.OPERATOR_ADDRESS,
        ceiling: 10,
        expiresAt: store.now() + 60,
      },
      env.PRIVATE_KEY,
    );
    store.set(`ticket:${ticketId}`, ticket);
    return Response.json(ticket);
  }
  if (path === "/qualify") {
    const { result } = await body<{ result: Signed<Result> }>(request);
    const data = await verify(result, "result", env.OPERATOR_ADDRESS);
    const ticket = store.get<Signed<Ticket>>(`ticket:${data.ticketId}`)?.body;
    check(
      ticket &&
        data.participant === session.wallet &&
        data.participant === ticket.participant &&
        data.communityId === env.COMMUNITY_ID &&
        data.songHash === ticket.songHash &&
        data.attemptId === digest(data.ticketId),
      "result_binding_mismatch",
    );
    check(
      data.summaryHash === digest(data.summary) &&
        data.summary.scoreBps >= 7000 &&
        data.summary.coverageBps === 10000 &&
        data.summary.scoringVersion === 5,
      "not_qualified",
    );
    check(
      data.endedAt <= store.now() &&
        data.endedAt < Number(env.CUTOFF) &&
        store.now() < Number(env.CUTOFF),
      "late_entry",
    );
    const key = `entry:${session.wallet}`;
    const old = store.get<Result>(key);
    if (!old) store.set(key, data);
    return Response.json({ entry: old ?? data });
  }
  return new Response("not_found", { status: 404 });
}
