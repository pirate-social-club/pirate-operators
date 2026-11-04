// The operator's learning-records publisher (docs/learning-records-contract.md).
// A finalized karaoke result is published only when its learner consented on
// the live socket. Each write is an intent in the durable sender, persisted
// before any RPC call, and the stages run strictly in order: open the attempt,
// write every line record, then complete it.
import {
  createPublicClient,
  encodeFunctionData,
  hashTypedData,
  hexToBigInt,
  http,
  recoverTypedDataAddress,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import { check, digest, sign, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  rewardScore,
  verifyKaraokeResult,
  type KaraokeManifest,
  type KaraokeResultBody,
  type LineOutcome,
} from "../packages/protocol/payments.ts";
import {
  ACTIVITY_KARAOKE,
  COMPLETION_STATUS_CODES,
  CONSENT_LIFETIME_S,
  LINE_STATUS_CODES,
  consentMessage,
  consentTypes,
  lineKeyOf,
  linesRootOf,
  manifestLeaves,
  merkleProof,
  recordsAbi,
  recordsDomain,
  songKeyOf,
  standInSong,
  textKey,
  type Consent,
  type SongKey,
} from "../packages/protocol/records.ts";
import { acceptedByAccount, activationOf, checkActivation, codeOf, designatorOf, nonceOf } from "./accounts.ts";
import { dispatch, enqueue, intentOf, type TxKind } from "./operator-tx.ts";
import { operatorQuote } from "./purchases.ts";
import { signatureChainId, type Env, type Store } from "./runtime.ts";

/**
 * Gas limits with headroom over MegaETH testnet measurements
 * (docs/megaeth-testnet.md): open 380,190, one line about 230,000, and a
 * 40-line completion 283,019. Completion reads every line, so it scales.
 * Unused gas is not charged.
 */
export const RECORD_GAS = {
  /** A learner account's activation; 182,952 on a MegaETH fork. */
  activate: 1_500_000n,
  open: 1_000_000n,
  line: 600_000n,
  complete: (linesTotal: number) => 500_000n + 5_000n * BigInt(linesTotal),
} as const;

export interface StoredConsent {
  consent: Consent;
  signature: Hex;
}
export interface Publication {
  /** The result revision being published; corrections publish later revisions. */
  revision: number;
  ordinals: number[];
  state: "pending" | "published" | "failed";
  reason?: string;
}
const publicationKey = (ticketId: string) => `publication:${ticketId}`;
export const publicationOf = (store: Store, ticketId: string) =>
  store.get<Publication>(publicationKey(ticketId));

const recordsOf = (env: Env) => env.RECORDS_CONTRACT as Address | undefined;
const recordsChain = (env: Env) => Number(env.PAYMENT_CHAIN_ID ?? 31337);
function loaded(store: Store, ticketId: string) {
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
  const manifest = ticket && store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`);
  return { ticket, manifest };
}
const songOf = (env: Env, ticket: Ticket): SongKey =>
  standInSong(recordsChain(env), ticket.communityId, ticket.songHash);

/** The consent the learner is asked to sign for one attempt; deterministic per attempt. */
export function consentFor(
  env: Env,
  ticket: Ticket,
  manifest: KaraokeManifest,
  attemptId: Hex,
  startedAt: number,
): Consent {
  return {
    learner: ticket.participant,
    attemptId,
    songKey: songKeyOf(songOf(env, ticket)),
    contentRevision: ticket.manifestSha256,
    linesRoot: linesRootOf(manifest),
    linesTotal: manifest.lines.length,
    activity: ACTIVITY_KARAOKE,
    grader: env.OPERATOR_ADDRESS,
    scoringPolicy: textKey(operatorQuote(env).scoringPolicy),
    expiresAt: startedAt + CONSENT_LIFETIME_S,
  };
}
/** What the socket's ready message offers for signing, or nothing when records are off. */
export function consentRequest(env: Env, store: Store, ticketId: string, attemptId: Hex, startedAt: number) {
  const records = recordsOf(env);
  const { ticket, manifest } = loaded(store, ticketId);
  if (!records || !ticket || !manifest) return undefined;
  return {
    domain: recordsDomain(recordsChain(env), records),
    message: consentFor(env, ticket, manifest, attemptId, startedAt),
  };
}

/**
 * Accepts the learner's signature over the offered consent. Only a plain
 * account's low-s ECDSA signature is checked here; the contract also accepts
 * ERC-1271, which this check does not yet cover.
 */
export async function acceptConsent(
  env: Env,
  store: Store,
  ticketId: string,
  attempt: { attemptId: Hex; startedAt: number },
  signature: unknown,
) {
  const request = consentRequest(env, store, ticketId, attempt.attemptId, attempt.startedAt);
  check(request, "records_unconfigured");
  check(typeof signature === "string" && /^0x([0-9a-fA-F]{2}){65,8000}$/.test(signature), "invalid_consent");
  const sig = signature as Hex;
  const typed = {
    domain: request.domain,
    types: consentTypes,
    primaryType: "Consent" as const,
    message: consentMessage(request.message),
  };
  const learner = request.message.learner;
  // A plain account's low-s ECDSA signature is checked locally.
  const plain =
    size(sig) === 65 &&
    hexToBigInt(slice(sig, 32, 64)) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n &&
    (await recoverTypedDataAddress({ ...typed, signature: sig }).catch(() => undefined))?.toLowerCase() ===
      learner.toLowerCase();
  if (!plain) {
    // Anything else is a smart account's: an ERC-8010 activation must belong to
    // the learner and use the approved contracts, and the RPC must accept it.
    check(env.RPC_URL, "invalid_consent");
    const activation = activationOf(sig);
    if (activation) await checkActivation(env, learner, activation, recordsChain(env));
    const client = createPublicClient({ transport: http(env.RPC_URL) });
    const valid = await client.verifyTypedData({ ...typed, address: learner, signature: sig }).catch(() => false);
    check(valid, "invalid_consent");
  }
  store.set(`consent:${ticketId}`, { consent: request.message, signature: sig } satisfies StoredConsent);
}

/** What the contract checks: an activation's inner signature, or the signature as given. */
const openingSignature = (stored: StoredConsent) => activationOf(stored.signature)?.inner ?? stored.signature;
const consentDigestOf = (env: Env, consent: Consent) =>
  hashTypedData({
    domain: recordsDomain(recordsChain(env), recordsOf(env)!),
    types: consentTypes,
    primaryType: "Consent",
    message: consentMessage(consent),
  });
const openData = (env: Env, ticket: Ticket, stored: StoredConsent) =>
  encodeFunctionData({
    abi: recordsAbi,
    functionName: "openAttempt",
    args: [{ ...stored.consent, expiresAt: BigInt(stored.consent.expiresAt) }, openingSignature(stored), {
      ...songOf(env, ticket),
      chainId: BigInt(recordsChain(env)),
    }],
  });
function lineData(manifest: KaraokeManifest, attemptId: Hex, outcome: LineOutcome, ordinal: number) {
  const line = manifest.lines[ordinal - 1];
  check(line.lineId === outcome.lineId && line.lineVersion === outcome.lineVersion, "line_list_mismatch");
  return encodeFunctionData({
    abi: recordsAbi,
    functionName: "assessLines",
    args: [
      attemptId,
      [
        {
          ordinal,
          lineKey: lineKeyOf(line.lineId),
          lineVersion: line.lineVersion,
          status: LINE_STATUS_CODES[outcome.status],
          scoreBps: outcome.scoreBps ?? 0,
          final_: true,
          proof: merkleProof(manifestLeaves(manifest), ordinal - 1),
        },
      ],
    ],
  });
}
const completeData = (result: KaraokeResultBody) =>
  encodeFunctionData({
    abi: recordsAbi,
    functionName: "completeAttempt",
    args: [
      result.attemptId,
      {
        // Karaoke's completedAt is when singing stopped, never the decision time.
        completedAt: BigInt(result.performanceEndedAt),
        status: COMPLETION_STATUS_CODES[result.status],
        unmeasuredCount: result.unmeasuredCount,
        hasRewardScore: result.rewardScoreBps !== null,
        rewardScoreBps: result.rewardScoreBps ?? 0,
      },
    ],
  });

/**
 * Ends the publication this publisher started with, but only if it is still
 * the current one. A publisher resumes after awaiting the chain, and by then a
 * correction may have replaced its revision; that newer state must stand.
 */
function settle(store: Store, ticketId: string, from: Publication, next: Publication) {
  return store.transaction(() => {
    const current = publicationOf(store, ticketId);
    if (current?.revision !== from.revision || current.state !== "pending") return current;
    store.set(publicationKey(ticketId), next);
    return next;
  });
}
const failed = (store: Store, ticketId: string, publication: Publication, reason: string) =>
  settle(store, ticketId, publication, { ...publication, state: "failed", reason });
/** Dispatches one intent; undefined while its outcome is unknown, false if it reverted. */
async function step(env: Env, store: Store, kind: TxKind, ref: string) {
  const row = await dispatch(env, store, kind, ref);
  if (!row?.mined) return undefined;
  return row.mined.status === "success";
}

/**
 * Whether the learner's account will accept the consent when the attempt
 * opens. A plain account always will. An account with no code is activated
 * first, once, from its ERC-8010 signature. Code alone proves nothing, because
 * an EIP-7702 delegation persists even when the setup call reverts, so any
 * account with code must accept the consent through ERC-1271; a delegated
 * account that does not gets its setup call once more, without the
 * authorization. Each step is an intent in the durable sender.
 */
async function accountReady(env: Env, store: Store, stored: StoredConsent): Promise<"ready" | "pending" | string> {
  const { learner, attemptId } = stored.consent;
  const activation = activationOf(stored.signature);
  let code = await codeOf(env, learner);
  if (code === "0x") {
    if (!activation) return "ready";
    if (!intentOf(store, "record_activate", attemptId)) {
      await checkActivation(env, learner, activation, recordsChain(env)).catch((e: Error) => {
        throw new Error(`activation_refused:${e.message}`);
      });
      if (activation.authorization.nonce !== (await nonceOf(env, learner))) return "authorization_nonce_stale";
    }
    enqueue(store, "record_activate", attemptId, activation.initializer, activation.data, RECORD_GAS.activate, [
      activation.authorization,
    ]);
    const activated = await step(env, store, "record_activate", attemptId);
    if (activated === undefined) return "pending";
    if (store.get("fault:crash-after-activation")) {
      store.delete("fault:crash-after-activation");
      throw new Error("simulated_crash_after_activation");
    }
    code = await codeOf(env, learner);
    if (code === "0x") return "activation_not_applied";
  }
  const digest = consentDigestOf(env, stored.consent);
  const signature = openingSignature(stored);
  if (await acceptedByAccount(env, learner, digest, signature)) return "ready";
  if (!activation || code !== designatorOf(activation.authorization.address)) return "consent_refused_by_account";
  enqueue(store, "record_initialize", attemptId, activation.initializer, activation.data, RECORD_GAS.activate);
  const initialized = await step(env, store, "record_initialize", attemptId);
  if (initialized === undefined) return "pending";
  return (await acceptedByAccount(env, learner, digest, signature)) ? "ready" : "account_not_initialized";
}

/**
 * Moves a consented, finalized result's publication forward. Safe to call
 * repeatedly and concurrently: every write is an idempotent intent, and a
 * stage only starts once the one before it is mined.
 */
export async function publish(env: Env, store: Store, ticketId: string) {
  const records = recordsOf(env);
  const stored = store.get<StoredConsent>(`consent:${ticketId}`);
  const signed = store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`);
  const { ticket, manifest } = loaded(store, ticketId);
  if (!records || !stored || !signed || !ticket || !manifest) return undefined;
  const result = signed.body;
  let publication = publicationOf(store, ticketId);
  if (!publication) {
    publication = { revision: 1, ordinals: manifest.lines.map((l) => l.ordinal), state: "pending" };
    store.set(publicationKey(ticketId), publication);
  }
  if (publication.state !== "pending") return publication;
  // The result and its publication change together, so they always agree here.
  check(publication.revision === result.revision, "publication_revision_mismatch");
  const attemptId = stored.consent.attemptId;

  if (!intentOf(store, "record_open", attemptId)) {
    if (stored.consent.expiresAt <= store.now()) return failed(store, ticketId, publication, "consent_expired");
    const account = await accountReady(env, store, stored);
    if (account === "pending") return publication;
    if (account !== "ready") return failed(store, ticketId, publication, account);
    if (store.get("fault:crash-before-open")) {
      store.delete("fault:crash-before-open");
      throw new Error("simulated_crash_before_open");
    }
  }
  enqueue(store, "record_open", attemptId, records, openData(env, ticket, stored), RECORD_GAS.open);
  const opened = await step(env, store, "record_open", attemptId);
  if (opened === undefined) return publication;
  if (!opened) return failed(store, ticketId, publication, "open_reverted");

  // Every line intent is recorded before the first is sent, then sent in order.
  const lineRef = (ordinal: number) => `${attemptId}:${ordinal}:${publication!.revision}`;
  for (const ordinal of publication.ordinals)
    enqueue(
      store,
      "record_line",
      lineRef(ordinal),
      records,
      lineData(manifest, attemptId, result.lines[ordinal - 1], ordinal),
      RECORD_GAS.line,
    );
  for (const ordinal of publication.ordinals) {
    if (store.get("fault:crash-before-line") === ordinal) {
      store.delete("fault:crash-before-line");
      throw new Error("simulated_crash_before_line");
    }
    const assessed = await step(env, store, "record_line", lineRef(ordinal));
    if (assessed === undefined) return publication;
    if (!assessed) return failed(store, ticketId, publication, `line_reverted:${ordinal}`);
  }

  const completeRef = `${attemptId}:${publication.revision}`;
  enqueue(store, "record_complete", completeRef, records, completeData(result), RECORD_GAS.complete(result.linesTotal));
  const completed = await step(env, store, "record_complete", completeRef);
  if (completed === undefined) return publication;
  if (!completed) return failed(store, ticketId, publication, "complete_reverted");
  return settle(store, ticketId, publication, { ...publication, state: "published" });
}

/**
 * Corrects one line of a published result. The corrected result is a new
 * signed revision checked by the same verifier; the next ticks publish a final
 * correction for that line followed by a new completion.
 */
export async function correct(
  env: Env,
  store: Store,
  input: { ticketId: string; lineId: string; status: LineOutcome["status"]; scoreBps: number | null },
) {
  const publication = publicationOf(store, input.ticketId);
  check(publication?.state === "published", "publication_not_complete");
  const signed = store.get<Signed<KaraokeResultBody>>(`result:${input.ticketId}`)!;
  const { manifest } = loaded(store, input.ticketId);
  check(manifest, "unknown_ticket");
  const previous = signed.body;
  const index = previous.lines.findIndex((l) => l.lineId === input.lineId);
  check(index >= 0, "unknown_line");
  const lines = previous.lines.map((line, i) =>
    i === index ? { ...line, status: input.status, scoreBps: input.scoreBps } : line,
  );
  check(digest(lines) !== previous.linesHash, "no_change");
  const next: KaraokeResultBody = {
    ...previous,
    revision: previous.revision + 1,
    lines,
    linesHash: digest(lines),
    ...rewardScore(lines),
  };
  const quote = operatorQuote(env);
  verifyKaraokeResult(next, manifest, quote);
  const signedNext = await sign("result", next, env.PRIVATE_KEY, signatureChainId(env));
  // Signing yields, so the state read above is checked again; the new result
  // and its pending publication then land together or not at all.
  store.transaction(() => {
    const current = publicationOf(store, input.ticketId);
    check(
      store.get<Signed<KaraokeResultBody>>(`result:${input.ticketId}`)?.body.revision === previous.revision &&
        current?.revision === previous.revision &&
        current.state === "published",
      "correction_conflict",
    );
    store.set(`resultRevision:${input.ticketId}:${previous.revision}`, signed);
    store.set(`result:${input.ticketId}`, signedNext);
    store.set(publicationKey(input.ticketId), {
      revision: next.revision,
      ordinals: [index + 1],
      state: "pending",
    } satisfies Publication);
  });
  return next;
}
