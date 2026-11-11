import { digest } from "../packages/protocol/index.ts";
import {
  sameScope,
  type BotRegistration,
} from "../packages/telegram/contracts.ts";
import type { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import type { StudyOperatorAuthority } from "../packages/study/operator-auth.ts";
import { address, chain } from "../packages/community/manifest-core.ts";
import type { connectedFactoryFixture } from "./telegram-connected-factory-fixture.ts";
import type {
  TelegramTransition,
  TelegramDenialChild,
} from "../packages/telegram/transitions.ts";

export function boundaryError(error: unknown) {
  if (!(error instanceof Error)) return "non_error";
  // Codes only. No message body, transcript, request, signed header or cookie.
  return /^[a-z][a-z0-9_]{0,159}$/.test(error.message)
    ? error.message
    : error.name;
}

export async function connectedBoundary(
  f: Awaited<ReturnType<typeof connectedFactoryFixture>>,
) {
  const { shared, options } = f;
  const rows = await shared.db
    .prepare(
      `SELECT (SELECT count(*) FROM study_lessons WHERE account_id=?1) AS lessons,
      (SELECT count(*) FROM study_publications WHERE account_id=?1) AS publications,
      (SELECT count(*) FROM study_lessons l JOIN study_publications p USING(lesson_id)
        WHERE l.account_id=?1) AS joined,
      (SELECT count(*) FROM learning_authorizations WHERE account_id=?1 AND state='recorded') AS authorizations`,
    )
    .bind(f.session.account_id)
    .first()
    .catch((error: unknown) => ({ unavailable: boundaryError(error) }));
  return {
    publication: publicationBoundary(
      f.factory.transitions,
      options.registration,
      {
        communityId: options.study.config.communityId,
        chainId: chain(Number(options.study.env.KARAOKE_PAYMENT_CHAIN_ID)),
        operator: address(
          options.study.env.KARAOKE_OPERATOR_ADDRESS?.toLowerCase(),
        ),
        contract: address(options.study.config.learningRecords),
      },
    ),
    rows,
    updates: f.journal.store
      .entries<{
        state: string;
        retryAt: number;
        update: { kind: string };
      }>("update:", 20)
      .map(({ value }) => ({
        state: value.state,
        retryAt: value.retryAt,
        kind: value.update.kind,
      })),
    // Presentation kinds only; no user text or signed callback payloads.
    deliveries: f.sent.map(({ message }) => message.kind),
    providerCalls: shared.counts().calls,
  };
}

/** Test diagnostics only. Read the actual journal; never supply readiness or
 * authority, repair state, expose private lesson bodies, or dispatch work. */
export function publicationBoundary(
  publication: TelegramManagedPublication,
  registration: BotRegistration,
  target: StudyOperatorAuthority,
) {
  const grants = publication.grants;
  const store = grants.store;
  const actual = store.get<BotRegistration>(`bot:${registration.communityId}`);
  const prefix = registration.communityId;
  return {
    targetMatches: store.get(`publication-target:${prefix}`) === digest(target),
    registrationMatches: !!actual && sameScope(actual, registration),
    enabledMatches: actual?.enabled === registration.enabled,
    managed: !!store.get(`bot-publication-managed:${prefix}`),
    lineage: !!store.get(`bot-lineage:${prefix}`),
    scopeChange: !!grants.pendingPublicationScope(prefix),
    corruptCount: store.entries(`publication-corrupt:${prefix}:`, 10).length,
    readyCount: store.entries(`publication-ready:${prefix}:`, 10).length,
    actualGeneration: actual?.generation ?? null,
    requestedGeneration: registration.generation,
    transitions: store
      .entries<TelegramTransition>("publication-transition:", 10)
      .map(({ value: op }) => ({
        kind: op.kind,
        complete: op.complete,
        sealed: op.sealed,
        attempts: op.attempts,
        children: op.children,
        acknowledged: op.acknowledged,
        nextAtDeltaMs: op.nextAt - grants.now(),
        targetMatches: digest(op.target) === digest(target),
        fromGeneration: op.change?.from.generation ?? null,
        toGeneration: op.change?.to.generation ?? null,
        childSignals: Array.from(
          { length: Math.min(op.children, 5) },
          (_, index) => {
            const child = store.get<TelegramDenialChild>(
              `publication-child:${op.id}:${String(index).padStart(12, "0")}`,
            );
            return {
              present: !!child,
              acknowledged: child?.acknowledged ?? false,
              hashMatches: !!child && digest(child.denial) === child.hash,
            };
          },
        ),
      })),
  };
}

/** A completed tick can mean the bot caught a production refusal. Race the
 * actual processing promise against entry, so a test cannot wait 90s for a
 * remote call which has already been refused. The caller still releases its
 * gate and retains every assertion after dispatch. */
export async function requireFactoryGate(
  entered: Promise<void>,
  processing: Promise<unknown>,
  label: string,
  inspect: () => unknown | Promise<unknown>,
) {
  let reached = false;
  await Promise.race([
    entered.then(() => {
      reached = true;
    }),
    processing.then(
      async () => {
        if (reached) return;
        throw new Error(
          `factory_gate_not_reached:${label}:${JSON.stringify(await inspect())}`,
        );
      },
      async (cause: unknown) => {
        if (reached) return;
        throw new Error(
          `factory_processing_failed:${label}:${JSON.stringify(await inspect())}`,
          { cause },
        );
      },
    ),
  ]);
}
