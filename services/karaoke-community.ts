// Karaoke in the community application: the learner's tickets, per-line
// purchases, consent relay and reload recovery for one published song. The
// existing community purchase code runs unchanged on the application's D1
// database (migration 0008) with the real clock. The operator is reached by
// service binding; the learner's socket goes to the operator's public origin.
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bytes32, insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import {
  check,
  digest,
  verify,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import {
  quoteIdOf,
  validateManifest,
  verifyKaraokeResult,
  type AttemptStart,
  type KaraokeManifest,
  type KaraokeResultBody,
  type OperatorQuote,
} from "../packages/protocol/payments.ts";
import {
  ensureTicket,
  openTicket,
  settleTicket,
  signSegmentPurchase,
  trustedQuote,
  type WalletState,
} from "./community-purchases.ts";
import type { Env } from "./runtime.ts";
import { call, signatureChainId } from "./service-call.ts";
import { consentTypes } from "../packages/protocol/records.ts";
import { D1Store } from "./storage.ts";
import type { PublicReadPorts } from "./community-public.ts";
import { publishedKaraoke } from "./karaoke-song.ts";

/** The application's Karaoke bindings. Karaoke is off until all are present. */
export interface KaraokeEnv {
  KARAOKE_SPEECH_BUDGET?: DurableObjectNamespace<import("./speech-budget.ts").SpeechBudget>;
  KARAOKE_SERVICE_MODE?: "internal";
  KARAOKE_OPERATOR?: Fetcher;
  KARAOKE_OPERATOR_ADDRESS?: string;
  /** The operator's public origin, where the learner's socket connects. */
  KARAOKE_OPERATOR_ORIGIN?: string;
  /** The community's ticket and purchase signer: OperatorPayments signer(community). */
  KARAOKE_SIGNER_PRIVATE_KEY?: string;
  /** The community's address in OperatorPayments. */
  KARAOKE_COMMUNITY_ADDRESS?: string;
  KARAOKE_PAYMENT_CHAIN_ID?: string;
  KARAOKE_PAYMENT_TOKEN?: string;
  KARAOKE_RPC_URL?: string;
  KARAOKE_SIGNATURE_CHAIN_ID?: string;
}
export interface KaraokeLearner {
  wallet: string;
}

const configured = (env: KaraokeEnv, config: CommunityConfig) =>
  !!(
    env.KARAOKE_OPERATOR &&
    env.KARAOKE_OPERATOR_ADDRESS &&
    env.KARAOKE_OPERATOR_ORIGIN &&
    /^0x[0-9a-fA-F]{64}$/.test(env.KARAOKE_SIGNER_PRIVATE_KEY ?? "") &&
    env.KARAOKE_COMMUNITY_ADDRESS &&
    env.KARAOKE_PAYMENT_CHAIN_ID &&
    env.KARAOKE_PAYMENT_TOKEN &&
    env.KARAOKE_RPC_URL &&
    (env.KARAOKE_SERVICE_MODE === "internal" || config.operatorPayments !== "0x0000000000000000000000000000000000000000")
  );
export const karaokeAvailable = configured;

/** The shape the existing community purchase code reads. */
function runtimeEnv(env: KaraokeEnv, config: CommunityConfig): Env {
  insist(configured(env, config), "karaoke_unavailable", 503);
  return {
    SERVICE_MODE: env.KARAOKE_SERVICE_MODE,
    OPERATOR: env.KARAOKE_OPERATOR!,
    OPERATOR_ADDRESS: env.KARAOKE_OPERATOR_ADDRESS as Address,
    PRIVATE_KEY: env.KARAOKE_SIGNER_PRIVATE_KEY as Hex,
    COMMUNITY_ID: config.communityId,
    COMMUNITY_ADDRESS: env.KARAOKE_COMMUNITY_ADDRESS,
    PAYMENT_CHAIN_ID: env.KARAOKE_PAYMENT_CHAIN_ID,
    PAYMENT_TOKEN: env.KARAOKE_PAYMENT_TOKEN,
    PAYMENTS_CONTRACT: config.operatorPayments,
    RPC_URL: env.KARAOKE_RPC_URL,
    SIGNATURE_CHAIN_ID: env.KARAOKE_SIGNATURE_CHAIN_ID,
  } as unknown as Env;
}

/** The community purchase store, on its own table and the real clock. */
class KaraokeStore extends D1Store {
  private readonly clock: () => number;
  constructor(db: D1Database, clock: () => number) {
    super(db, 0, "karaoke_state");
    this.clock = clock;
  }
  override async now() {
    return Math.floor(this.clock() / 1000);
  }
}

export interface KaraokePorts {
  env: KaraokeEnv;
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  now?: () => number;
}
const socketUrl = (env: KaraokeEnv) => {
  const origin = new URL(env.KARAOKE_OPERATOR_ORIGIN!);
  origin.protocol = origin.protocol === "http:" ? "ws:" : "wss:";
  return new URL("/attempt", origin).toString();
};

async function prepared(ports: KaraokePorts, postId: Hex) {
  const env = runtimeEnv(ports.env, ports.config),
    store = new KaraokeStore(ports.db, ports.now ?? Date.now),
    manifest = await publishedKaraoke(
      ports.db,
      ports.config,
      ports.reads,
      postId,
    ),
    quote = await trustedQuote(env, store);
  validateManifest(manifest, quote.maxSegmentMs);
  const manifestSha256 = digest(manifest) as Hex;
  if (ports.env.KARAOKE_SERVICE_MODE === "internal" && ports.reads.manifestAvailable)
    insist(await ports.reads.manifestAvailable(manifestSha256), "public_result_manifest_unavailable", 503);
  await store.set(`manifest:${manifestSha256}`, manifest);
  await store.set(`manifestFor:${manifest.songHash}`, manifestSha256);
  return { env, store, manifest, manifestSha256, quote };
}

/**
 * The ticket's session key is held here, per ticket, and only its connection
 * proof is given to the signed-in learner. Any tab or reload of the same
 * learner can then reconnect, and the browser needs no key material. The key
 * authorizes only that ticket's operator socket; records still need the
 * learner's own consent signature.
 */
async function sessionKeyFor(
  store: KaraokeStore,
  current: WalletState | undefined,
  songHash: Hex,
) {
  if (current?.open && current.open.songHash === songHash)
    return current.open.sessionKey;
  const secret = generatePrivateKey(),
    address = privateKeyToAccount(secret).address;
  await store.set(`sessionSecret:${address}`, secret);
  return address;
}
async function connectionProof(
  store: KaraokeStore,
  sessionKey: Address,
  ticketId: Hex,
) {
  const secret = await store.get<Hex>(`sessionSecret:${sessionKey}`);
  insist(secret, "session_key_unavailable", 409);
  return privateKeyToAccount(secret).signMessage({
    message: `connect:${ticketId}`,
  });
}

/** One open ticket per learner; a retry for the same song returns it. */
export async function karaokeTicket(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  value: Record<string, unknown>,
) {
  const postId = bytes32(value.postId);
  const { env, store, manifest, manifestSha256, quote } = await prepared(
      ports,
      postId,
    ),
    wallet = learner.wallet as Address,
    sessionKey = await sessionKeyFor(
      store,
      await store.get<WalletState>(`wallet:${wallet}`),
      manifest.songHash,
    ),
    now = await store.now(),
    lastEndMs = manifest.segments.at(-1)!.endMs,
    open = await openTicket(
      store,
      wallet,
      {
        songHash: manifest.songHash,
        sessionKey,
        quoteId: quoteIdOf(quote),
        manifestSha256,
        maxPaidSegments: manifest.segments.length,
        maxAmount: (
          BigInt(manifest.segments.length) * BigInt(quote.segmentPrice)
        ).toString(),
        maxDurationMs: lastEndMs + 5000,
        issuedAt: now,
        expiresAt: now + Math.ceil(lastEndMs / 1000) + 120,
      },
      (sequence) =>
        digest({
          community: env.COMMUNITY_ID,
          participant: wallet,
          songHash: manifest.songHash,
          sequence,
        }) as Hex,
    ).catch((error: Error) => {
      // Codes from the shared purchase code become client errors here.
      insist(false, error.message, 409);
      throw error;
    });
  return {
    ticket: await ensureTicket(env, store, wallet, open),
    socketUrl: socketUrl(ports.env),
    proof: await connectionProof(store, open.sessionKey, open.ticketId),
  };
}

export async function karaokePurchase(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  value: Record<string, unknown>,
) {
  const env = runtimeEnv(ports.env, ports.config),
    store = new KaraokeStore(ports.db, ports.now ?? Date.now);
  check(env.SERVICE_MODE !== "internal", "purchases_disabled");
  try {
    return await signSegmentPurchase(env, store, learner.wallet as Address, {
      ticketId: bytes32(value.ticketId),
      segmentId: String(value.segmentId ?? ""),
      take: Number(value.take ?? 0),
      attemptStart: value.attemptStart as Signed<AttemptStart> | undefined,
    });
  } catch (error) {
    insist(false, (error as Error).message, 409);
    throw error;
  }
}

async function ownedTicket(store: KaraokeStore, wallet: string, ticketId: Hex) {
  const ticket = await store.get<Signed<Ticket>>(`ticket:${ticketId}`);
  insist(
    ticket && ticket.body.participant.toLowerCase() === wallet.toLowerCase(),
    "ticket_not_found",
    404,
  );
  return ticket;
}

/** The operator's signed result, bound to this community's ticket, manifest and quote. */
async function boundResult(
  env: Env,
  store: KaraokeStore,
  ticket: Ticket,
): Promise<Signed<KaraokeResultBody> | null> {
  let signed: Signed<KaraokeResultBody>;
  try {
    signed = await call<Signed<KaraokeResultBody>>(env.OPERATOR, "/result", {
      ticketId: ticket.ticketId,
    });
  } catch (error) {
    if ((error as Error).message === "result_not_final") return null;
    throw error;
  }
  const data = await verify(
    signed,
    "result",
    env.OPERATOR_ADDRESS,
    signatureChainId(env),
  );
  check(
    data.ticketId === ticket.ticketId &&
      data.participant === ticket.participant &&
      data.communityId === ticket.communityId &&
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
  return signed;
}

/**
 * Reload recovery. The learner's open ticket for this song, so the same tab
 * can reconnect within the operator's window; or its final result, which
 * also releases the ticket so another take can begin.
 */
export async function karaokeAttempt(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  postId: Hex,
) {
  const env = runtimeEnv(ports.env, ports.config),
    store = new KaraokeStore(ports.db, ports.now ?? Date.now),
    wallet = learner.wallet as Address,
    state = await store.get<WalletState>(`wallet:${wallet}`),
    last = await store.get<Hex>(`lastTicket:${wallet}:${postId}`),
    manifest = await publishedKaraoke(
      ports.db,
      ports.config,
      ports.reads,
      postId,
    ),
    ticketId =
      state?.open?.songHash === manifest.songHash ? state.open.ticketId : last;
  if (!ticketId) return { state: "none" as const };
  const ticket = (await ownedTicket(store, wallet, ticketId)).body,
    result = await boundResult(env, store, ticket);
  if (state?.open?.ticketId === ticketId && env.SERVICE_MODE === "internal" && !result) {
    const signedStart = await call<Signed<AttemptStart> | null>(env.OPERATOR, "/attempt-start", { ticketId });
    if (signedStart) {
      const start = await verify(signedStart, "attempt_start", env.OPERATOR_ADDRESS, signatureChainId(env));
      check(start.ticketId === ticketId, "attempt_start_mismatch");
      state.open.startedAt = start.startedAt;
    }
  }
  if (state?.open?.ticketId === ticketId) {
    // A ticket that never produced a result is released once it expires.
    if (!result && (await store.now()) >= state.open.expiresAt) {
      await settleTicket(env, store, wallet, ticketId, false);
      return { state: "none" as const };
    }
    if (!result)
      return {
        state: "open" as const,
        ticket: await store.get<Signed<Ticket>>(`ticket:${ticketId}`),
        // From the operator's start, set by the first purchase, on this
        // clock: the page resumes the song here, whatever its own clock says.
        elapsedMs:
          state.open.startedAt === null
            ? null
            : Math.max(0, ((await store.now()) - state.open.startedAt) * 1000),
        socketUrl: socketUrl(ports.env),
        proof: await connectionProof(store, ticket.sessionKey, ticketId),
      };
    await settleTicket(env, store, wallet, ticketId, true);
    await store.set(`lastTicket:${wallet}:${postId}`, ticketId);
  }
  if (!result) return { state: "none" as const };
  const record = await call<{
    attemptId: Hex;
    consented: boolean;
    consent: { domain: unknown; message: unknown } | null;
    publication: { state: string; reason?: string } | null;
  }>(env.OPERATOR, "/record", { ticketId });
  return {
    state: "finished" as const,
    result,
    record: {
      ...record,
      // Everything a wallet needs to sign it, without protocol code.
      consent: record.consent && {
        ...record.consent,
        types: consentTypes,
        primaryType: "Consent" as const,
      },
    },
  };
}

/** Consent after the socket has closed: the operator checks the learner's signature. */
export async function karaokeConsent(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  value: Record<string, unknown>,
) {
  const env = runtimeEnv(ports.env, ports.config),
    store = new KaraokeStore(ports.db, ports.now ?? Date.now),
    ticketId = bytes32(value.ticketId);
  await ownedTicket(store, learner.wallet, ticketId);
  return call<{ consented: boolean; attemptId: Hex }>(
    env.OPERATOR,
    "/consent",
    {
      ticketId,
      signature: object(value).signature,
    },
  );
}

/** Standing consent is requested before ticket preparation; the operator verifies it. */
export async function karaokeEnrollments(ports: KaraokePorts, learner: KaraokeLearner) {
  const env = runtimeEnv(ports.env, ports.config);
  check(env.SERVICE_MODE === "internal", "enrollment_unavailable");
  return call(env.OPERATOR, "/enrollment/list", { learner: learner.wallet });
}

export async function karaokeEnrollment(ports: KaraokePorts, learner: KaraokeLearner, value: Record<string, unknown>) {
  const env = runtimeEnv(ports.env, ports.config);
  check(env.SERVICE_MODE === "internal", "enrollment_unavailable");
  if (!value.signature) return call(env.OPERATOR, "/enrollment/request", { learner: learner.wallet, target: value.target });
  const enrollment = object(value.enrollment);
  check(String(enrollment.learner).toLowerCase() === learner.wallet.toLowerCase(), "wrong_learner");
  return call(env.OPERATOR, "/enrollment", { enrollment, signature: value.signature, target: value.target });
}

export async function karaokeHistory(ports: KaraokePorts, learner: KaraokeLearner, value: Record<string, unknown>) {
  const env = runtimeEnv(ports.env, ports.config), store = new KaraokeStore(ports.db, ports.now ?? Date.now);
  const ticketId = bytes32(value.ticketId), ticket = await ownedTicket(store, learner.wallet, ticketId);
  return call(env.OPERATOR, "/history", { ticketId, proof: await connectionProof(store, ticket.body.sessionKey, ticketId) });
}

export async function karaokeRevokeEnrollment(ports: KaraokePorts, learner: KaraokeLearner, value: Record<string, unknown>) {
  const env = runtimeEnv(ports.env, ports.config);
  check(env.SERVICE_MODE === "internal", "enrollment_unavailable");
  return call(env.OPERATOR, "/enrollment/revoke", { learner: learner.wallet, target: value.target,
    ...(value.signature ? { nonce: String(object(value.message).nonce), signature: value.signature } : {}) });
}
