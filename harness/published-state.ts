// One exact completed release; this update never resets or replenishes a grant.
import {
  canonical,
  hashJson,
  hashText,
  insist,
  object,
} from "../packages/community/common.ts";
import { readFile } from "node:fs/promises";
import {
  assertRetainedRows,
  readRetainedBaseline,
} from "./retained-state-rules.ts";
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
/**
 * The one reviewed successor of the published state: the November 9 settlement
 * of the first song's managed release-grant reservation. The published state
 * file and its hash stay unchanged as historical evidence; this record names
 * the exact managed summaries that changed and their provenance.
 */
export const publishedStateRepairHash =
  "0x3c1edf26321013f6c065362281c23d6cef15b1749abb7a6b4efc2b117f568e2c";
export const publishedStateRepairPath =
  "docs/deployments/first-song-managed-20261105.published-state-repair-20261109.json";
type Summary = Record<string, { count: number; sha256: string }>;
/** The expected summaries for one side after the reviewed repair, if any. */
export function repairedSummaries(
  expected: unknown,
  side: CuratedSide,
  repair?: unknown,
): Summary {
  const summaries = object(object(expected)[side]) as Summary;
  if (repair === undefined) return summaries;
  const r = object(repair);
  insist(
    hashJson(repair) === publishedStateRepairHash &&
      r.schema === "pirate.published-first-song-state-repair/1" &&
      r.predecessorStateSha256 === hashJson(expected) &&
      hashJson(expected) === publishedStateHash,
    "published_state_repair_changed",
    409,
  );
  if (r.side !== side) return summaries;
  const next = { ...summaries };
  for (const [table, change] of Object.entries(object(r.summaries))) {
    const c = object(change);
    insist(
      canonical(summaries[table]) === canonical(c.from),
      "published_state_repair_predecessor_changed",
      409,
    );
    next[table] = c.to as Summary[string];
  }
  return next;
}
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
/**
 * The reviewed per-row baseline of the pinned state, derived offline from the
 * November 9 read-only capture (0xefac3b8c…14b3) taken before any owner
 * upload, derived independently by both release lanes. Without an owner
 * grant, releases keep the exact summary comparison.
 */
export const retainedStateBaseline = {
  path: "docs/deployments/first-song-managed-20261105.retained-state-baseline-20261109.json",
  sha256:
    "0xe55db57bc27eed959f7ff4d1045b0520e3b7e3da9aa4e33eaf48a8b064022846" as
      | string
      | null,
};
/** The rules path of qualifyRetainedState, on already captured rows. */
export function assertRetainedAgainstBaseline(
  text: string,
  sha256: string,
  expected: unknown,
  repair: unknown,
  side: CuratedSide,
  rows: Record<string, Record<string, unknown>[]>,
  ownerGrant: unknown,
  nowSeconds: number,
) {
  insist(hashText(text) === sha256, "retained_state_baseline_changed", 409);
  const record = readRetainedBaseline(JSON.parse(text));
  insist(
    hashJson(expected) === publishedStateHash &&
      record.predecessorStateSha256 === publishedStateHash &&
      record.repairSha256 === publishedStateRepairHash &&
      (repair === undefined || hashJson(repair) === publishedStateRepairHash),
    "retained_state_baseline_unbound",
    409,
  );
  return assertRetainedRows(
    side,
    rows,
    record[side],
    ownerGrant,
    nowSeconds,
    Date.parse(record.capturedAt),
  );
}
/**
 * Under owner publishing with a pinned baseline, the live tables are accepted
 * by the retained-state rules: pinned rows retained, operational columns
 * moved legally, and growth only under the active owner grant. Otherwise the
 * live summaries must equal the pinned ones, as before.
 */
export async function qualifyRetainedState(
  token: string,
  accountId: string,
  expected: unknown,
  side: CuratedSide,
  repair?: unknown,
  ownerGrant?: unknown,
  baseline = retainedStateBaseline,
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
  if (ownerGrant !== undefined && baseline.sha256 !== null) {
    assertRetainedAgainstBaseline(
      await readFile(baseline.path, "utf8"),
      baseline.sha256,
      expected,
      repair,
      side,
      captured.rows,
      ownerGrant,
      Math.floor(Date.now() / 1000),
    );
    return captured.summary;
  }
  assertRetainedPublishedState(
    captured,
    repairedSummaries(expected, side, repair),
    side,
  );
  return captured.summary;
}
