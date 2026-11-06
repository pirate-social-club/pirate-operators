// One exact completed release; this update never resets or replenishes a grant.
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  captureCuratedState,
  qualifyCuratedState,
  readOnlyRemoteDb,
  type CuratedSide,
  type CuratedState,
  curatedDatabases,
} from "./curated-state.ts";

export const publishedStateHash =
  "0x84a0c5d483c9dc0a0c486ee8ea892c45b1bc10c7e4bd363991e7ed3ef38284ec";
export const publishedBaselines = {
  application:
    "0x23fed40c87eee9dc22b71169d56553a40419b8283ea141437cab6d67aa73e279",
  managed: "0x7e5c29fe883ef7cdb07afdfda5040004f5031aad1108f1c7a5dc78b404956705",
} as const;
export function assertPublishedUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  side: CuratedSide,
) {
  insist(
    hashJson(previous) === publishedBaselines[side] &&
      hashJson(next.curatedState) === publishedStateHash,
    "published_upgrade_baseline_changed",
    409,
  );
  const allowed = [
      "sourceHashes",
      "bundleSha256",
      "bundleBytes",
      "reviewedUpdate",
      "update",
      "curatedState",
      ...(side === "application" ? ["managedProfileHash"] : []),
    ],
    intent = (p: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(p).filter(([k]) => !allowed.includes(k)),
      );
  insist(
    canonical(intent(previous)) === canonical(intent(next)),
    "published_upgrade_changes_resource_or_spending_intent",
    409,
  );
}
export async function capturePublishedState(db: D1Database, side: CuratedSide) {
  const captured = await captureCuratedState(db, side);
  for (const table of side === "application"
    ? [
        "media_stems",
        "publication_amendments",
        "external_operation_reconciliations",
        "moderation_input_capabilities",
        "spending_budgets",
        "spending_reservations",
      ]
    : ["curated_admissions", "moderation_request_nonces"]) {
    const rows = (
      await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()
    ).results.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    captured.rows[table] = rows;
    captured.summary[table] = { count: rows.length, sha256: hashJson(rows) };
  }
  return captured;
}
export function assertRetainedPublishedState(
  captured: Awaited<ReturnType<typeof capturePublishedState>>,
  expected: Record<string, { count: number; sha256: string }>,
  side: CuratedSide,
) {
  const summary = { ...captured.summary };
  // This pinned publication predates learner sign-in. Keep its one original
  // account and credential binding byte-for-byte while allowing additions.
  if (side === "application")
    for (const table of ["community_accounts", "credential_bindings"]) {
      const original = expected[table];
      if (
        original?.count === 1 &&
        captured.rows[table]?.some((row) => hashJson([row]) === original.sha256)
      )
        summary[table] = original;
    }
  insist(
    hashJson(summary) === hashJson(expected),
    "published_state_changed",
    409,
  );
}
export async function qualifyRetainedState(
  token: string,
  accountId: string,
  expected: unknown,
  side: CuratedSide,
) {
  if (object(expected).schema === "pirate.held-first-song-state/1")
    return qualifyCuratedState(
      token,
      accountId,
      expected as CuratedState,
      side,
    );
  insist(
    object(expected).schema === "pirate.published-first-song-state/1" &&
      hashJson(expected) === publishedStateHash,
    "published_state_profile_changed",
    409,
  );
  const captured = await capturePublishedState(
    readOnlyRemoteDb(token, accountId, curatedDatabases[side]),
    side,
  );
  assertRetainedPublishedState(
    captured,
    object(expected)[side] as Record<string, { count: number; sha256: string }>,
    side,
  );
  return captured.summary;
}
