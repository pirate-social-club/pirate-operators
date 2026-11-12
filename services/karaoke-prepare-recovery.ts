// Proposed versioned /prepare extension. Legacy prepare remains unchanged.
import { privateKeyToAccount } from "viem/accounts";
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
  validateManifest,
  type KaraokeManifest,
} from "../packages/protocol/payments.ts";
import { retainedTarget, sameResultsTarget } from "./learning-contract.ts";
import { authorizationState } from "./learning-authorization.ts";
import { bindAuthorization, ticketAuthorization } from "./learning-results.ts";
import { studyAuthorizationState } from "./study-authorization.ts";
import { operatorQuote } from "./purchases.ts";
import {
  preparationBody,
  verifyPrepared,
  type KaraokePreparation,
  type KaraokePrepared,
} from "./karaoke-preparation.ts";
import { signatureChainId } from "./service-call.ts";
import type { Env, Store } from "./runtime.ts";

export async function prepareRecovery(
  env: Env,
  store: Store,
  input: {
    ticket: Signed<Ticket>;
    manifest: KaraokeManifest;
    preparation: KaraokePreparation;
  },
) {
  const ticket = await verify(
    input.ticket,
    "ticket",
    env.ISSUER,
    signatureChainId(env),
  );
  const p = input.preparation;
  check(
    p.version === 1 &&
      p.target.version === 4 &&
      env.SERVICE_MODE === "internal",
    "karaoke_recovery_scope_required",
  );
  const key = `karaokePreparedV1:${ticket.ticketId}`;
  const live = async () => {
    check(store.now() < ticket.expiresAt, "karaoke_reservation_expired");
    check(
      !store.get<{ ended?: unknown }>(`attempt:${ticket.ticketId}`)?.ended &&
        !store.get(`result:${ticket.ticketId}`),
      "karaoke_result_pending",
    );
    const target = retainedTarget(env, p.target);
    const quote = operatorQuote(env);
    validateManifest(input.manifest, quote.maxSegmentMs);
    check(
      ticket.communityId === env.COMMUNITY_ID &&
        ticket.community.toLowerCase() ===
          env.COMMUNITY_ADDRESS?.toLowerCase() &&
        ticket.operator.toLowerCase() === env.OPERATOR_ADDRESS.toLowerCase() &&
        privateKeyToAccount(env.PRIVATE_KEY).address.toLowerCase() ===
          env.OPERATOR_ADDRESS.toLowerCase() &&
        ticket.mode === "performance" &&
        ticket.authorizationId &&
        ticket.quoteId === quoteIdOf(quote) &&
        ticket.manifestSha256 === digest(input.manifest) &&
        ticket.songHash === input.manifest.songHash &&
        Number.isSafeInteger(p.authorizationIssuedAt) &&
        p.authorizationIssuedAt > 0 &&
        p.authorizationIssuedAt <= ticket.issuedAt &&
        ticket.issuedAt <= store.now(),
      "karaoke_preparation_scope_changed",
    );
    const old = store.get<Signed<Ticket>>(`ticket:${ticket.ticketId}`);
    check(!old || digest(old) === digest(input.ticket), "ticket_conflict");
    const oldManifest = store.get<KaraokeManifest>(
      `manifest:${ticket.manifestSha256}`,
    );
    check(
      !oldManifest || digest(oldManifest) === ticket.manifestSha256,
      "karaoke_manifest_changed",
    );
    const bound = ticketAuthorization(store, ticket.ticketId);
    check(
      !bound ||
        (bound.id === ticket.authorizationId &&
          bound.issuedAt === p.authorizationIssuedAt &&
          sameResultsTarget(bound.target, target)),
      "karaoke_authorization_mismatch",
    );
    const state = await studyAuthorizationState(
      env,
      target,
      ticket.participant,
      ticket.authorizationId!,
    );
    check(
      state.ownedBy && state.issuedAt === p.authorizationIssuedAt,
      "karaoke_authorization_mismatch",
    );
    check(state.unbroken, "karaoke_authorization_required");
    // Also observes accepted-but-unmined revocation. A cached preparation
    // receipt does not authorize new private work after withdrawal intent.
    const current = await authorizationState(env, ticket.participant, store);
    check(
      !current.pendingWithdrawal &&
        current.since > 0 &&
        current.since <= p.authorizationIssuedAt &&
        current.revokedAt < p.authorizationIssuedAt,
      "karaoke_authorization_required",
    );
    check(store.now() < ticket.expiresAt, "karaoke_reservation_expired");
  };
  await live();
  const prior = store.get<Signed<KaraokePrepared>>(key);
  if (prior)
    await verifyPrepared(
      prior,
      input.ticket,
      p,
      env.OPERATOR_ADDRESS,
      signatureChainId(env),
    );
  // Existing exact binding returns without reserving sponsorship again.
  await bindAuthorization(
    env,
    store,
    ticket.ticketId,
    ticket.participant,
    ticket.authorizationId!,
  );
  const ack =
    prior ??
    (await sign(
      "karaoke_prepared_v1",
      preparationBody(input.ticket, p),
      env.PRIVATE_KEY,
      signatureChainId(env),
    ));
  await live();
  store.transaction(() => {
    check(store.now() < ticket.expiresAt, "karaoke_reservation_expired");
    const concurrent = store.get<Signed<KaraokePrepared>>(key);
    check(
      !concurrent || digest(concurrent) === digest(ack),
      "karaoke_preparation_ack_mismatch",
    );
    const old = store.get<Signed<Ticket>>(`ticket:${ticket.ticketId}`);
    check(!old || digest(old) === digest(input.ticket), "ticket_conflict");
    store.set(`ticket:${ticket.ticketId}`, input.ticket);
    store.set(`manifest:${ticket.manifestSha256}`, input.manifest);
    store.set(key, ack);
  });
  check(
    digest(store.get(key)) === digest(ack),
    "karaoke_preparation_ack_not_durable",
  );
  // Recheck after durable writes and before exposing acknowledgement. Even
  // a lost response can be retried with the original bytes and same receipt.
  await live();
  return { prepared: true as const, acknowledgement: ack };
}
