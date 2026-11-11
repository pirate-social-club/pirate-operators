import {
  accountSession,
  authenticatedWrite,
  type AuthContext,
} from "../packages/community/accounts.ts";
import {
  bytes32,
  insist,
  integer,
  jsonBody,
  text,
} from "../packages/community/common.ts";
import type {
  RewardChain,
  RewardOfferInput,
  RewardSources,
  RewardVerificationProvider,
  RewardsProfile,
  RewardWalletView,
} from "../packages/rewards/contracts.ts";
import {
  RewardStore,
  type OfferRow,
  type PaymentRow,
} from "../packages/rewards/store.ts";
import { RewardOffers, offerView } from "../packages/rewards/offers.ts";
import { RewardClaims } from "../packages/rewards/claims.ts";
import { RewardPayments } from "../packages/rewards/payments.ts";
import {
  rewardAddress,
  rewardId,
  rewardAmount,
} from "../packages/rewards/validation.ts";
import { RewardTreasury } from "../packages/rewards/treasury.ts";
import { rehearsalTerms } from "../packages/rewards/rehearsal.ts";
import { rewardCloseReadiness } from "../packages/rewards/close-readiness.ts";

export interface RewardsApiPorts {
  db: D1Database;
  profile: RewardsProfile;
  chain: RewardChain;
  verification: RewardVerificationProvider;
  sources?: RewardSources;
  now?: () => number;
  songs?: () => Promise<{ songKey: string; title: string; postId?: string }[]>;
  /** Safe-confirmed timestamp in Unix milliseconds; absence never unlocks closing. */
  confirmedCutoffTimestamp?: () => Promise<number>;
}
/** Uses the pilot's host-only account cookie. No central persona or Privy authentication is accepted. */
export async function rewardsCommunityApi(
  request: Request,
  ports: RewardsApiPorts,
  context: AuthContext,
  headers: Headers,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    !path.startsWith("/api/rewards/") &&
    !path.startsWith("/api/operator/rewards")
  )
    return null;
  const session =
    request.method === "GET"
      ? await accountSession(request, ports.db, context)
      : await authenticatedWrite(request, ports.db, context);
  const principal = {
      accountId: session.account_id,
      wallet: rewardAddress(session.wallet),
    },
    store = new RewardStore(ports.db, ports.profile);
  await store.init();
  const claims = new RewardClaims(store, ports.verification, ports.now),
    payments = new RewardPayments(store, ports.chain, ports.now, ports.sources);
  const treasury = new RewardTreasury(store, ports.chain);
  const reply = (value: unknown) => Response.json(value, { headers });
  const get = () => insist(request.method === "GET", "method_not_allowed", 405),
    post = () => insist(request.method === "POST", "method_not_allowed", 405);
  const isOperator = principal.wallet === ports.profile.operatorWallet;
  if (path === "/api/rewards/offers") {
    get();
    const rows = await store
      .statement(
        "SELECT * FROM reward_offers WHERE program_id=? AND state='open' AND cutoff_at>? ORDER BY cutoff_at LIMIT 100",
        store.program,
        (ports.now ?? Date.now)(),
      )
      .all<OfferRow>();
    const songs = await (ports.songs?.() ?? Promise.resolve([]));
    return reply({
      practiceOnly: true,
      offers: rows.results.map((r) => ({
        offerId: r.offer_id,
        postId: songs.find((s) => s.songKey === r.song_key)?.postId ?? null,
        drawingId: r.drawing_id,
        opensAt: r.opens_at,
        cutoffAt: r.cutoff_at,
        ticketCount: (JSON.parse(r.ticket_ids_json) as string[]).length,
      })),
    });
  }
  if (path === "/api/rewards/wallet") {
    get();
    let balance: string | null = null;
    try {
      balance = await ports.chain.balance(ports.profile, principal.wallet);
    } catch {
      /* Never render an unavailable balance as zero. */
    }
    const drawings = await store
      .statement(
        "SELECT * FROM reward_offers WHERE program_id=? ORDER BY cutoff_at DESC LIMIT 100",
        store.program,
      )
      .all<OfferRow>();
    const value: RewardWalletView = {
      schema: "pirate.learner-wallet/1",
      address: principal.wallet,
      chainId: 6343,
      token: ports.profile.token,
      decimals: ports.profile.decimals,
      balanceAtomic: balance,
      operator: isOperator,
      practiceOnly: true,
      drawings: drawings.results.map((row) => ({
        offerId: row.offer_id,
        drawingId: row.drawing_id,
        cutoffAt: row.cutoff_at,
        state: row.state,
        qualified:
          row.entries_json === null
            ? null
            : (JSON.parse(row.entries_json) as { accountId: string }[]).some(
                (e) => e.accountId === principal.accountId,
              ),
      })),
    };
    return reply(value);
  }
  if (path === "/api/rewards/credits") {
    get();
    const cursor = url.searchParams.get("cursor") ?? "",
      raw = url.searchParams.get("limit") ?? "100";
    insist(/^[1-9][0-9]{0,2}$/.test(raw), "invalid_reward_page");
    const limit = integer(Number(raw), 1, 100);
    if (cursor) rewardId(cursor);
    const rows = await store.credits(principal.accountId, cursor, limit + 1),
      items = rows.slice(0, limit);
    return reply({
      object: "reward_credit_list",
      items: items.map((r) => store.creditView(r)),
      next_cursor: rows.length > limit ? items.at(-1)!.credit_id : null,
    });
  }
  const claim = /^\/api\/rewards\/credits\/([a-zA-Z0-9_-]{8,128})\/claim$/.exec(
    path,
  );
  if (claim) {
    post();
    return reply(await claims.claim(principal, claim[1]));
  }
  if (path === "/api/rewards/claim-verification-intents") {
    post();
    return reply(await claims.intent(principal));
  }
  const intent =
    /^\/api\/rewards\/verification-intents\/([a-zA-Z0-9_-]{8,128})(\/complete)?$/.exec(
      path,
    );
  if (intent) {
    if (intent[2]) post();
    else get();
    return reply(await claims.readIntent(principal, intent[1], !!intent[2]));
  }
  if (path.startsWith("/api/operator/rewards")) {
    insist(isOperator, "reward_operator_required", 403);
    if (path === "/api/operator/rewards") {
      get();
      const [offers, paymentRows, ready, inventory, funding] =
        await Promise.all([
          store
            .statement(
              "SELECT * FROM reward_offers WHERE program_id=? ORDER BY cutoff_at DESC LIMIT 100",
              store.program,
            )
            .all<OfferRow>(),
          store
            .statement(
              "SELECT * FROM reward_payments WHERE program_id=? ORDER BY prepared_at DESC LIMIT 100",
              store.program,
            )
            .all<PaymentRow>(),
          store
            .statement(
              "SELECT c.account_id,c.wallet,c.credit_id,c.amount_atomic FROM reward_credits c WHERE c.program_id=? AND c.claim_state='accepted' AND c.payment_id IS NULL AND c.paid_atomic='0' ORDER BY c.account_id,c.credit_id LIMIT 501",
              store.program,
            )
            .all<{
              account_id: string;
              wallet: string;
              credit_id: string;
              amount_atomic: string;
            }>(),
          store
            .statement(
              "SELECT received_atomic,reserved_atomic,paid_atomic,cost_atomic FROM reward_inventory WHERE program_id=?",
              store.program,
            )
            .first(),
          store
            .statement(
              "SELECT funding_id,kind,source_json,amount_atomic,transaction_hash,log_index FROM reward_funding WHERE program_id=? ORDER BY funding_id LIMIT 100",
              store.program,
            )
            .all(),
        ]);
      insist(ready.results.length <= 500, "reward_operator_page_limit", 409);
      const unpaid = await store
        .statement(
          "SELECT amount_atomic,paid_atomic,claim_state FROM reward_credits WHERE program_id=? AND paid_atomic='0' ORDER BY credit_id LIMIT 5001",
          store.program,
        )
        .all<{
          amount_atomic: string;
          paid_atomic: string;
          claim_state: string;
        }>();
      insist(unpaid.results.length <= 5000, "reward_operator_page_limit", 409);
      const liabilities = { total: 0n, unclaimed: 0n, held: 0n, accepted: 0n };
      for (const credit of unpaid.results) {
        const amount =
          rewardAmount(credit.amount_atomic) - rewardAmount(credit.paid_atomic);
        liabilities.total += amount;
        liabilities[
          credit.claim_state === "unclaimed"
            ? "unclaimed"
            : credit.claim_state === "subject_conflict"
              ? "held"
              : "accepted"
        ] += amount;
      }
      const checkedAt = (ports.now ?? Date.now)();
      let confirmedTimestamp: number | null = null;
      if (
        ports.confirmedCutoffTimestamp &&
        offers.results.some(
          (offer) => offer.state === "open" && offer.cutoff_at <= checkedAt,
        )
      ) {
        try {
          const timestamp = await ports.confirmedCutoffTimestamp();
          if (Number.isSafeInteger(timestamp) && timestamp >= 0)
            confirmedTimestamp = timestamp;
        } catch {
          // Keep balances and liabilities available when confirmation cannot be read.
        }
      }
      return reply({
        closeReadiness: rewardCloseReadiness(
          offers.results.map(offerView),
          checkedAt,
          confirmedTimestamp,
        ),
        offers: offers.results.map(offerView),
        // What a new offer accepts when the operator names no sources.
        resultSources: ports.sources?.resultSources ?? null,
        payments: await Promise.all(
          paymentRows.results.map((p) => store.paymentView(p)),
        ),
        ready: ready.results,
        inventory,
        liabilities: Object.fromEntries(
          Object.entries(liabilities).map(([key, value]) => [
            key,
            value.toString(),
          ]),
        ),
        unmatched: (await treasury.unmatched()).map((r) =>
          JSON.parse(r.receipt_json),
        ),
        observedBalanceAtomic: await ports.chain
          .balance(ports.profile, ports.profile.payoutWallet)
          .catch(() => null),
        funding: funding.results,
        payoutWallet: ports.profile.payoutWallet,
        practiceOnly: true,
        simulatedWinnings: ports.profile.mode === "simulated",
        rehearsal: rehearsalTerms(ports.profile),
        decimals: ports.profile.decimals,
        token: ports.profile.token,
        chainId: 6343,
        songs: await (ports.songs?.() ?? Promise.resolve([])),
      });
    }
    post();
    const body = await jsonBody(request);
    if (path === "/api/operator/rewards/audit")
      return reply(await treasury.audit());
    if (path === "/api/operator/rewards/costs")
      return reply(
        await treasury.cost(
          text(body.id, 128),
          bytes32(body.hash),
          integer(body.logIndex, 0, 100000),
        ),
      );
    if (path === "/api/operator/rewards/funding")
      insist(
        body.kind === "prefunding" || body.kind === "conversion",
        "invalid_reward_funding_kind",
      );
    if (path === "/api/operator/rewards/funding")
      return reply(
        await payments.fund(
          text(body.id, 128),
          bytes32(body.hash),
          integer(body.logIndex, 0, 100000),
          {
            kind: body.kind === "conversion" ? "conversion" : "prefunding",
            sourceUsdcAtomic: text(body.sourceUsdcAtomic, 78),
            sourceTransactionHash:
              body.sourceTransactionHash === null
                ? null
                : bytes32(body.sourceTransactionHash),
            feeUsdcAtomic: text(body.feeUsdcAtomic, 78),
          },
        ),
      );
    if (path === "/api/operator/rewards/payments")
      return reply(
        await payments.prepare(text(body.id, 128), text(body.accountId, 128)),
      );
    const payment =
      /^\/api\/operator\/rewards\/payments\/([a-zA-Z0-9_-]{8,128})\/(dispatch|outcome|transaction|recover|reconcile|cancel)$/.exec(
        path,
      );
    if (payment) {
      const [_, id, action] = payment;
      if (action === "dispatch") {
        insist(
          body.action === "pay" || body.action === "cancel",
          "invalid_reward_payment_action",
        );
        return reply(
          await payments.dispatch(id, body.action, text(body.attemptId, 128)),
        );
      }
      if (action === "outcome") {
        insist(
          body.outcome === "approved" ||
            body.outcome === "cancelled" ||
            body.outcome === "error" ||
            body.outcome === "unknown",
          "invalid_reward_wallet_outcome",
        );
        return reply(
          await payments.outcome(
            id,
            text(body.attemptId, 128),
            body.outcome,
            body.hash === undefined ? undefined : bytes32(body.hash),
          ),
        );
      }
      if (action === "transaction")
        return reply(
          await payments.attach(
            id,
            bytes32(body.hash),
            text(body.attemptId, 128),
          ),
        );
      if (action === "recover")
        return reply(await payments.recover(id, bytes32(body.hash)));
      if (action === "reconcile") return reply(await payments.reconcile(id));
      return reply(await payments.cancelPrepared(id));
    }
    insist(ports.sources, "reward_sources_not_qualified", 503);
    const offers = new RewardOffers(store, ports.sources, ports.now);
    if (path === "/api/operator/rewards/offers") {
      insist(
        Array.isArray(body.ticketIds) &&
          body.ticketIds.every((x) => typeof x === "string"),
        "invalid_reward_tickets",
      );
      const input: RewardOfferInput = {
        offerId: text(body.offerId, 128),
        drawingId: text(body.drawingId, 78),
        songKey: bytes32(body.songKey),
        opensAt: integer(body.opensAt, 0, Number.MAX_SAFE_INTEGER),
        cutoffAt: integer(body.cutoffAt, 0, Number.MAX_SAFE_INTEGER),
        purchaseHash: bytes32(body.purchaseHash),
        ticketIds: body.ticketIds,
        ...(body.resultSources === undefined
          ? {}
          : {
              resultSources: (() => {
                insist(
                  Array.isArray(body.resultSources) &&
                    body.resultSources.length <= 8,
                  "reward_offer_sources_invalid",
                );
                return body.resultSources.map((x) => bytes32(x));
              })(),
            }),
      };
      const songs = await (ports.songs?.() ?? Promise.resolve([]));
      insist(
        songs.some((song) => song.songKey === input.songKey),
        "reward_song_not_published",
        409,
      );
      return reply(await offers.attach(input));
    }
    const offer =
      /^\/api\/operator\/rewards\/offers\/([a-zA-Z0-9_-]{8,128})\/(close|settle)$/.exec(
        path,
      );
    if (offer)
      return reply(
        await (offer[2] === "close"
          ? offers.close(offer[1])
          : offers.settle(
              offer[1],
              body.claimHash === undefined
                ? undefined
                : bytes32(body.claimHash),
            )),
      );
  }
  insist(false, "reward_route_not_found", 404);
}
