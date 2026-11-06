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
import {
  qualifies,
  quoteIdOf,
  validateManifest,
  verifyKaraokeResult,
  type AttemptStart,
  type KaraokeManifest,
  type OperatorQuote,
} from "../packages/protocol/payments.ts";
import {
  communityTick,
  ensureTicket,
  trustedQuote,
  openTicket,
  settleTicket,
  signAdmissionPurchase,
  signSegmentPurchase,
} from "./community-purchases.ts";
import { body, call, type Env, signatureChainId } from "./runtime.ts";
import type { AsyncStore } from "./storage.ts";

const rewardPolicy = { minRewardScoreBps: 7000, maxUnmeasuredBps: 1000 };

export async function community(request: Request, env: Env, store: AsyncStore) {
  const path = new URL(request.url).pathname;
  if (path === "/challenge") {
    const { wallet } = await body<{ wallet: Address }>(request);
    check(isAddress(wallet), "invalid_wallet");
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const now = await store.now();
    const message = createSiweMessage({
      address: wallet,
      chainId: signatureChainId(env),
      domain: env.COMMUNITY_DOMAIN,
      uri: `http://${env.COMMUNITY_DOMAIN}`,
      version: "1",
      nonce,
      issuedAt: new Date(now * 1000),
      statement: "Sign in to the local Pirate community.",
    });
    await store.set(`nonce:${nonce}`, { message, wallet, expires: now + 300 });
    return Response.json({ message, nonce });
  }
  if (path === "/session") {
    const { nonce, signature } = await body<{ nonce: string; signature: Hex }>(request);
    const key = `nonce:${nonce}`;
    const challenge = await store.get<{ message: string; wallet: Address; expires: number }>(key);
    check(challenge && challenge.expires > (await store.now()), "invalid_nonce");
    check(
      await verifyMessage({
        address: challenge.wallet,
        message: challenge.message,
        signature,
      }),
      "invalid_login",
    );
    check(await store.take(key), "nonce_replayed");
    const token = crypto.randomUUID();
    await store.set(`session:${token}`, {
      wallet: challenge.wallet,
      expires: (await store.now()) + 86400,
    });
    return Response.json({ token });
  }
  if (path === "/karaoke/settle") {
    await communityTick(env, store);
    return Response.json({ settled: true });
  }
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const session = token
    ? await store.get<{ wallet: Address; expires: number }>(`session:${token}`)
    : undefined;
  check(session && session.expires > (await store.now()), "session_required");
  if (path === "/songs") {
    const { song, manifest } = await body<{ song: Song; manifest: KaraokeManifest }>(request);
    check(song.communityId === env.COMMUNITY_ID, "wrong_community");
    const songHash = digest(song);
    check(manifest.songHash === songHash, "manifest_song_mismatch");
    const quote = await trustedQuote(env, store);
    validateManifest(manifest, quote.maxSegmentMs);
    await store.set(`manifestFor:${songHash}`, digest(manifest));
    await store.set(`manifest:${digest(manifest)}`, manifest);
    const jobId = digest({ kind: "admission", song });
    const purchase = await signAdmissionPurchase(env, store, quote, jobId);
    const evidence = await call<Signed<Evidence>[]>(env.OPERATOR, "/admit", { song, purchase });
    const records = await Promise.all(
      evidence.map((record) =>
        verify(record, "evidence", env.OPERATOR_ADDRESS, signatureChainId(env)),
      ),
    );
    const status = gate(song, records, await store.now());
    await store.set(`song:${songHash}`, { song, status, evidence });
    return Response.json({ songHash, status, hashes: inputHashes(song) });
  }
  if (path === "/tickets") {
    const { songHash, sessionKey } = await body<{ songHash: Hex; sessionKey: Address }>(request);
    check(isAddress(sessionKey), "invalid_session_key");
    check(
      (await store.get<{ status: string }>(`song:${songHash}`))?.status === "published",
      "unpublished_song",
    );
    const now = await store.now();
    check(now < Number(env.CUTOFF), "entry_closed");
    const quote = await trustedQuote(env, store);
    const manifestSha256 = await store.get<Hex>(`manifestFor:${songHash}`);
    const manifest =
      manifestSha256 && (await store.get<KaraokeManifest>(`manifest:${manifestSha256}`));
    check(manifest && manifestSha256, "manifest_missing");
    validateManifest(manifest, quote.maxSegmentMs);
    const lastEndMs = manifest.segments[manifest.segments.length - 1].endMs;
    // One compare-and-set on the wallet record; a retry returns the same ticket.
    const open = await openTicket(
      store,
      session.wallet,
      {
        songHash,
        sessionKey,
        quoteId: quoteIdOf(quote),
        manifestSha256,
        maxPaidSegments: manifest.segments.length,
        maxAmount: (BigInt(manifest.segments.length) * BigInt(quote.segmentPrice)).toString(),
        maxDurationMs: lastEndMs + 5000,
        issuedAt: now,
        expiresAt: now + Math.ceil(lastEndMs / 1000) + 120,
      },
      (sequence) =>
        digest({ community: env.COMMUNITY_ID, participant: session.wallet, songHash, sequence }),
    );
    return Response.json(await ensureTicket(env, store, session.wallet, open));
  }
  if (path === "/karaoke/purchases") {
    const input = await body<{
      ticketId: Hex;
      segmentId: string;
      take: number;
      attemptStart?: Signed<AttemptStart>;
    }>(request);
    return Response.json(await signSegmentPurchase(env, store, session.wallet, input));
  }
  if (path === "/qualify") {
    const { result } = await body<{ result: Signed<Result> }>(request);
    const data = await verify(result, "result", env.OPERATOR_ADDRESS, signatureChainId(env));
    const ticket = (await store.get<Signed<Ticket>>(`ticket:${data.ticketId}`))?.body;
    check(
      ticket &&
        data.participant === session.wallet &&
        data.participant === ticket.participant &&
        data.communityId === env.COMMUNITY_ID &&
        data.songHash === ticket.songHash &&
        data.manifestSha256 === ticket.manifestSha256 &&
        data.quoteId === ticket.quoteId &&
        data.community === ticket.community &&
        data.mode === ticket.mode &&
        data.attemptId === digest(data.ticketId),
      "result_binding_mismatch",
    );
    verifyKaraokeResult(
      data,
      (await store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`))!,
      (await store.get<OperatorQuote>(`quote:${ticket.quoteId}`))!,
    );
    // A signed result means the operator closed the ticket on chain.
    await settleTicket(env, store, session.wallet, data.ticketId, true);
    check(qualifies(data, rewardPolicy) && data.summary.scoringVersion === 5, "not_qualified");
    const now = await store.now();
    check(data.endedAt <= now && data.endedAt < Number(env.CUTOFF) && now < Number(env.CUTOFF), "late_entry");
    const key = `entry:${session.wallet}`;
    await store.insertIfAbsent(key, data);
    return Response.json({ entry: (await store.get<Result>(key))! });
  }
  return new Response("not_found", { status: 404 });
}
