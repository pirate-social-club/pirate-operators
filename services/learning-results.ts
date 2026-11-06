import {
  createPublicClient, encodeFunctionData, http, zeroHash, type Address, type Hex,
} from "viem";
import { check, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  enrollmentIdOf, enrollmentTypes, orderedExercisesHash, packOutcomes, resultPeriod,
  resultsAbi, resultsDomain, type Enrollment, type TerminalResult,
} from "../packages/protocol/learning-results.ts";
import { COMPLETION_STATUS_CODES, textKey } from "../packages/protocol/records.ts";
import type { KaraokeManifest, KaraokeResultBody } from "../packages/protocol/payments.ts";
import { dispatch, enqueue, intentOf, type TxKind, type TxStore } from "./operator-tx.ts";
import { acceptedByAccount, activationOf, checkActivation, codeOf, nonceOf } from "./accounts.ts";
import { chargeSponsorship, releaseSponsorship, reserveSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import type { Env, Store } from "./runtime.ts";

type ResultStore = TxStore & Pick<Store, "now">;

const target = (env: Env) => env.RESULTS_V2_CONTRACT as Address;
const client = (env: Env) => createPublicClient({ transport: http(env.RPC_URL) });
const read = <T>(env: Env, functionName: string, args: unknown[] = []) => client(env).readContract({
  address: target(env), abi: resultsAbi, functionName, args,
} as never) as Promise<T>;
export interface BoundEnrollment { id: Hex; issuedAt: number; expiresAt: number }
export async function activeEnrollment(env: Env, learner: Address): Promise<BoundEnrollment> {
  const [id, activities, issuedAt, expiresAt] = await read<readonly [Hex, bigint, bigint, bigint]>(env, "enrollments", [learner]);
  check(id !== zeroHash && (activities & 1n) !== 0n && expiresAt > BigInt(Math.floor(Date.now() / 1000)), "enrollment_required");
  return { id, issuedAt: Number(issuedAt), expiresAt: Number(expiresAt) };
}
export async function enrollmentRequest(env: Env, learner: Address, now: number) {
  const [nonce, publicityPolicy, communityId] = await Promise.all([
    read<bigint>(env, "nextNonce", [learner]), read<Hex>(env, "publicityPolicy"), read<Hex>(env, "communityId"),
  ]);
  const message = { learner, communityId, activities: "1", publicityPolicy, expiresAt: String(now + 30 * 86400), nonce: String(nonce) };
  return { domain: resultsDomain(Number(env.PAYMENT_CHAIN_ID), target(env)), types: enrollmentTypes, primaryType: "Enrollment", message };
}
export async function submitResultTransaction(env: Env, store: ResultStore, kind: TxKind, ref: string, data: Hex,
  destination: Address = target(env), authorizationList?: Parameters<typeof enqueue>[6]) {
  const limits = sponsorLimits(env);
  reserveSponsorship(store, limits, `${kind}:${ref}`);
  enqueue(store, kind, ref, destination, data, limits.gas, authorizationList);
  // Keep the full maximum charged across unknown/reverted results and restarts.
  chargeSponsorship(store, limits, `${kind}:${ref}`);
  return dispatch(env, store, kind, ref, { maxFeePerGas: limits.gasPrice, maxTotalFee: limits.cap });
}
export async function acceptEnrollment(env: Env, store: ResultStore, e: Enrollment, signature: Hex) {
  check(e.communityId.toLowerCase() === env.COMMUNITY_ID.toLowerCase(), "wrong_community");
  const id = enrollmentIdOf(Number(env.PAYMENT_CHAIN_ID), target(env), e);
  const activation = activationOf(signature);
  if (activation) {
    await checkActivation(env, e.learner, activation, Number(env.PAYMENT_CHAIN_ID));
    const verified = await client(env).verifyTypedData({ address: e.learner, domain: resultsDomain(Number(env.PAYMENT_CHAIN_ID), target(env)),
      types: enrollmentTypes, primaryType: "Enrollment", message: { ...e }, signature });
    check(verified, "invalid_consent");
    if (await codeOf(env, e.learner) === "0x") {
      check(env.APPROVED_ACTIVATION_ACCOUNT?.toLowerCase() === e.learner.toLowerCase(), "account_activation_not_approved");
      if (!intentOf(store, "record_activate", id))
        check(activation.authorization.nonce === await nonceOf(env, e.learner), "authorization_nonce_stale");
      reserveSponsorship(store, sponsorLimits(env), `record_activate:${id}`);
      reserveSponsorship(store, sponsorLimits(env), `record_enroll:${id}`);
      store.set(`pendingEnrollment:${e.learner.toLowerCase()}`, { enrollment: { ...e, activities: String(e.activities), expiresAt: String(e.expiresAt), nonce: String(e.nonce) }, signature });
      const activated = await submitResultTransaction(env, store, "record_activate", id, activation.data,
        activation.initializer, [activation.authorization]);
      if (!activated?.mined) return activated;
      check(activated.mined.status === "success", "account_activation_failed");
    }
    check(await acceptedByAccount(env, e.learner, id, activation.inner), "consent_refused_by_account");
  }
  const data = encodeFunctionData({ abi: resultsAbi, functionName: "enroll", args: [e, activation?.inner ?? signature] });
  // Simulation rejects invalid consent before reserving/signing any transaction.
  if (!intentOf(store, "record_enroll", id)) await client(env).call({ to: target(env), data });
  const row = await submitResultTransaction(env, store, "record_enroll", id, data);
  if (row?.mined?.status === "success") store.delete(`pendingEnrollment:${e.learner.toLowerCase()}`);
  return row;
}
export const publicationV2 = (store: ResultStore, ticketId: string) => store.get<{
  state: "pending" | "published" | "private" | "failed"; revision: number; reason?: string;
}>(`publicationV2:${ticketId}`);
export async function bindEnrollment(env: Env, store: ResultStore, ticketId: string, learner: Address) {
  const grant = await activeEnrollment(env, learner);
  const previous = store.get<BoundEnrollment>(`enrollment:${ticketId}`);
  check(!previous || previous.id === grant.id, "enrollment_changed");
  reserveSponsorship(store, sponsorLimits(env), `record_result:${ticketId}:1`);
  store.set(`enrollment:${ticketId}`, grant);
}
export async function publishV2(env: Env, store: ResultStore, ticketId: string) {
  const signed = store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`);
  const ticket = store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
  const bound = store.get<BoundEnrollment>(`enrollment:${ticketId}`);
  if (!signed || !ticket || !bound) return;
  const result = signed.body, revision = result.revision, ref = `${ticketId}:${revision}`;
  const oldState = publicationV2(store, ticketId);
  if (oldState?.revision === revision && oldState.state !== "pending") return oldState;
  const state = { state: "pending" as const, revision };
  store.set(`publicationV2:${ticketId}`, state);
  const manifest = store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`)!;
  check(manifest.song, "published_song_required");
  const stored = store.get<{ result: TerminalResult; outcomes: Hex }>(`bundleV2:${ticketId}`);
  const current = await read<Hex>(env, "commitments", [result.attemptId]);
  if (revision === 1 && !intentOf(store, "record_result", ref)) {
    const [id, , , expires] = await read<readonly [Hex, bigint, bigint, bigint]>(env, "enrollments", [ticket.participant]);
    if (id !== bound.id || Number(expires) <= store.now()) {
      releaseSponsorship(store, sponsorLimits(env), `record_result:${ref}`);
      const next = { state: "private" as const, revision, reason: "enrollment_inactive" };
      store.set(`publicationV2:${ticketId}`, next); return next;
    }
  }
  const header: TerminalResult = {
    sessionId: result.attemptId, learner: ticket.participant, enrollmentId: bound.id,
    song: { ...manifest.song, chainId: BigInt(manifest.song.chainId) },
    contentRevision: result.manifestSha256, exercisesHash: orderedExercisesHash(result.lines.length),
    linesTotal: result.lines.length, activity: 1, grader: env.OPERATOR_ADDRESS,
    scoringPolicy: textKey(`karaoke-scoring/${result.summary.scoringVersion}`),
    qualificationPolicy: await read<Hex>(env, "policyFor", [resultPeriod(BigInt(result.performanceEndedAt))]),
    startedAt: BigInt(result.startedAt), completedAt: BigInt(result.performanceEndedAt),
    status: COMPLETION_STATUS_CODES[result.status], revision, supersedes: revision === 1 ? zeroHash : current,
  };
  const outcomes = packOutcomes(result.lines);
  // Bigints are encoded as decimal strings in the durable JSON store.
  const deserialize = (value: typeof stored) => value && ({ ...value.result,
    song: { ...value.result.song, chainId: BigInt(value.result.song.chainId) },
    startedAt: BigInt(value.result.startedAt), completedAt: BigInt(value.result.completedAt) });
  const data = revision === 1
    ? encodeFunctionData({ abi: resultsAbi, functionName: "publish", args: [header, outcomes] })
    : encodeFunctionData({ abi: resultsAbi, functionName: "correct", args: [deserialize(stored)!, stored!.outcomes, outcomes, header.status] });
  check(revision === 1 || stored?.result.revision === revision - 1, "missing_prior_bundle");
  const row = await submitResultTransaction(env, store, "record_result", ref, data);
  if (!row?.mined) return state;
  // A newer result may have appeared while this transaction was in flight.
  if (store.get<Signed<KaraokeResultBody>>(`result:${ticketId}`)?.body.revision !== revision) return state;
  const next = { state: row.mined.status === "success" ? "published" as const : "failed" as const, revision };
  if (row.mined.status === "success") store.set(`bundleV2:${ticketId}`, JSON.parse(JSON.stringify({ result: header, outcomes },
    (_, value) => typeof value === "bigint" ? String(value) : value)));
  store.set(`publicationV2:${ticketId}`, next);
  return next;
}

export async function resumeEnrollments(env: Env, store: ResultStore) {
  for (const { value } of store.entries("pendingEnrollment:")) {
    const job = value as { enrollment: Record<string, string>; signature: Hex }, e = job.enrollment;
    try {
      await acceptEnrollment(env, store, { learner: e.learner as Address, communityId: e.communityId as Hex,
        publicityPolicy: e.publicityPolicy as Hex, activities: BigInt(e.activities), expiresAt: BigInt(e.expiresAt), nonce: BigInt(e.nonce) }, job.signature);
    } catch { /* Keep authenticated unknown work for bounded recovery. */ }
  }
}
