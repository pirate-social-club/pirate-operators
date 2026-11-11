import { requireKaraokeRequestSession } from "./karaoke-request-session.ts";
// Proposed community recovery fence. Exact retained scope, never a new intent.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check, digest } from "../packages/protocol/index.ts";
import {
  quoteIdOf,
  type OperatorQuote,
} from "../packages/protocol/payments.ts";
import { practiceAuthorization, signInV4 } from "./learning-sign-in.ts";
import { signatureChainId } from "./service-call.ts";
import type { AsyncStore } from "./storage.ts";
import type { Env } from "./runtime.ts";
import type { KaraokePorts, KaraokeLearner } from "./karaoke-community.ts";
import type { Reservation, WalletState } from "./community-purchases.ts";
import type { KaraokeRecoveryScope } from "./karaoke-preparation.ts";

export const reservationHash = (open: Reservation) =>
  digest({ ...open, startedAt: null });
export async function recoveryScope(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  env: Env,
  postId: Hex,
  quote: OperatorQuote,
  authorizationId: Hex,
): Promise<KaraokeRecoveryScope> {
  const requestSession = requireKaraokeRequestSession(ports);
  await requestSession.check(learner);
  const target = signInV4(ports.env, ports.config);
  check(target && learner.account_id, "karaoke_recovery_scope_required");
  const chainId = target.chainId;
  check(chainId === 31337 || chainId === 6343, "unsupported_results_chain");
  const row = await ports.db
    .prepare(
      "SELECT issued_at FROM learning_authorizations WHERE authorization_id=? AND account_id=? AND subject=? AND state='recorded'",
    )
    .bind(authorizationId, learner.account_id, learner.wallet.toLowerCase())
    .first<{ issued_at: number }>();
  check(row, "karaoke_authorization_mismatch");
  await requestSession.check(learner);
  return {
    version: 1,
    accountId: learner.account_id!,
    wallet: learner.wallet as Address,
    postId,
    communityId: env.COMMUNITY_ID,
    community: env.COMMUNITY_ADDRESS as Address,
    issuer: privateKeyToAccount(env.PRIVATE_KEY).address,
    operator: env.OPERATOR_ADDRESS,
    operatorOrigin: new URL(ports.env.KARAOKE_OPERATOR_ORIGIN!).origin,
    paymentChainId: Number(env.PAYMENT_CHAIN_ID),
    signatureChainId: signatureChainId(env),
    payments: env.PAYMENTS_CONTRACT!,
    token: env.PAYMENT_TOKEN!,
    quoteHash: digest(quote) as Hex,
    authorizationId,
    preparation: {
      version: 1,
      target: {
        version: 4,
        chainId,
        contract: target.contract,
      },
      authorizationIssuedAt: row.issued_at,
    },
  };
}

/** Recreated for each request; only its serializable scope is stored. */
export function reservationFence(
  ports: KaraokePorts,
  learner: KaraokeLearner,
  env: Env,
  store: AsyncStore,
  postId: Hex,
  open: Reservation,
  manifestHash: Hex,
) {
  const requestSession = requireKaraokeRequestSession(ports);
  const identity = async () => {
    const s = open.recoveryScope;
    check(
      s?.version === 1 &&
        learner.account_id &&
        s.accountId === learner.account_id &&
        s.wallet.toLowerCase() === learner.wallet.toLowerCase(),
      "karaoke_recovery_scope_required",
    );
    const expected = await recoveryScope(
      ports,
      learner,
      env,
      postId,
      (await store.get<OperatorQuote>(`quote:${open.quoteId}`))!,
      open.authorizationId!,
    );
    check(digest(expected) === digest(s), "karaoke_recovery_scope_changed");
    const quote = await store.get<OperatorQuote>(`quote:${open.quoteId}`);
    check(
      quote &&
        quoteIdOf(quote) === open.quoteId &&
        digest(quote) === s.quoteHash &&
        quote.validFrom <= open.issuedAt &&
        open.issuedAt < quote.validUntil,
      "karaoke_quote_changed",
    );
    check(open.manifestSha256 === manifestHash, "karaoke_manifest_changed");
    const current = await store.get<WalletState>(`wallet:${learner.wallet}`);
    check(
      current?.open && reservationHash(current.open) === reservationHash(open),
      "karaoke_reservation_changed",
    );
    return s;
  };
  const live = async () => {
    await requestSession.check(learner);
    check((await store.now()) < open.expiresAt, "karaoke_reservation_expired");
    const s = await identity();
    const chosen = await practiceAuthorization(
      ports.env,
      ports.db,
      s.accountId,
      learner.wallet,
      open.issuedAt,
      (ports.now ?? Date.now)(),
      open.authorizationId,
    );
    check(
      chosen.id && chosen.id === open.authorizationId,
      "karaoke_authorization_required",
    );
    await identity();
    await requestSession.check(learner);
    check((await store.now()) < open.expiresAt, "karaoke_reservation_expired");
  };
  return { identity, live };
}
