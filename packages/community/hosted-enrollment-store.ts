import { canonical, exact, hashText, insist, object, token } from "./common.ts";
import { sharedBytes32 } from "./shared-identity.ts";
import {
  configureBudget,
  reserveBudget,
  settleBudget,
  type BudgetKey,
} from "./budgets.ts";
import {
  enrollmentDocument,
  HOSTED_NO_INVITE_ID,
  parseEnrollment,
  parsePolicyDocument,
  policyDocument,
  policyHash,
  wei,
  type Enrollment,
  type HostedPolicy,
} from "./hosted-enrollment.ts";
import type { Hex } from "viem";

// SHA-256 of canonical ordered sqlite_master name/type/normalized SQL, generated
// from the exact unapplied schema. Runtime never repairs or initializes a DB.
export const HOSTED_SCHEMA_SHA256 =
  "0xc8cd02e64c342f7daedc0a26b8a86ce9801f9aaeffac604de4589c81b2655a61";
/** Private package context; never part of policy or an HTTP/signature envelope. */
export interface HostedSchemaContext {
  readonly schema: "pirate.hosted-schema-alchemy/1";
  readonly table: "__alchemy_migrations";
  readonly migrations: ReadonlyArray<Readonly<{ name: string; hash: string }>>;
}
export function ownHostedSchemaContext(input: unknown): HostedSchemaContext {
  const value = object(structuredClone(input));
  exact(value, ["schema", "table", "migrations"]);
  insist(value.schema === "pirate.hosted-schema-alchemy/1" && value.table === "__alchemy_migrations" &&
    Array.isArray(value.migrations) && value.migrations.length === 1, "hosted_schema_mismatch", 503);
  const migrations = value.migrations.map(row => {
    const entry = object(row); exact(entry, ["name", "hash"]);
    insist(entry.name === "0001_hosted_enrollment.sql" && typeof entry.hash === "string" &&
      /^[0-9a-f]{64}(?![\s\S])/.test(entry.hash), "hosted_schema_mismatch", 503);
    return Object.freeze({ name: entry.name, hash: entry.hash });
  });
  return Object.freeze({ schema: "pirate.hosted-schema-alchemy/1", table: "__alchemy_migrations", migrations: Object.freeze(migrations) });
}
export async function assertHostedSchema(db: D1Database, context?: HostedSchemaContext) {
  const selected = context === undefined ? undefined : ownHostedSchemaContext(context);
  const rows = await db
    .prepare(
      "SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name <> '_cf_METADATA' ORDER BY name",
    )
    .all<{ name: string; type: string; sql: string }>();
  if (selected) {
    const internal = await db.prepare("SELECT type,sql FROM sqlite_master WHERE name='_cf_METADATA'").first<{ type: string; sql: string }>();
    insist(internal?.type === "table" && internal.sql.replace(/\s+/g, " ").trim() ===
      "CREATE TABLE _cf_METADATA ( key INTEGER PRIMARY KEY, value BLOB )", "hosted_schema_mismatch", 503);
    const metadata = rows.results.find(row => row.name === selected.table);
    // Installed @alchemy.run/sql SQLite createTableSql, pinned with the package.
    // SQLite removes IF NOT EXISTS on storage; the early real migrator gate
    // records the actual sqlite_master form, not a guessed database fingerprint.
    const ddl = 'CREATE TABLE "__alchemy_migrations" ( id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT )';
    insist(metadata?.type === "table" && metadata.sql.replace(/\s+/g, " ").trim() === ddl, "hosted_schema_mismatch", 503);
    const ledger = await db.prepare("SELECT id,hash,created_at,name,applied_at FROM __alchemy_migrations ORDER BY id")
      .all<{ id: number; hash: string; created_at: unknown; name: string; applied_at: unknown }>();
    insist(ledger.results.length === selected.migrations.length && ledger.results.every((row, index) => {
      const expected = selected.migrations[index]!;
      return row.id === index + 1 && row.hash === expected.hash && row.name === expected.name && row.created_at === null &&
        typeof row.applied_at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(row.applied_at);
    }), "hosted_schema_mismatch", 503);
  }
  const shape = rows.results.filter(row => !selected || row.name !== selected.table).map((r) => ({
    name: r.name,
    type: r.type,
    sql: r.sql.replace(/\s+/g, " ").trim(),
  }));
  insist(
    hashText(canonical(shape)) === HOSTED_SCHEMA_SHA256,
    "hosted_schema_mismatch",
    503,
  );
  const version = await db
    .prepare("SELECT version FROM hosted_schema")
    .all<{ version: number }>();
  insist(
    version.results.length === 1 && version.results[0]!.version === 1,
    "hosted_schema_mismatch",
    503,
  );
}
export interface Invite {
  id: Hex;
  token_hash: string;
  allowance_id: Hex;
  policy_hash: Hex;
  expires_at: number;
  revoked: number;
}
async function initializeBudgetNamespace(db: D1Database, p: HostedPolicy) {
  const g = token();
  await db.batch([
    db
      .prepare(
        "UPDATE hosted_schema SET budget_namespace=? WHERE version=1 AND budget_namespace IS NULL",
      )
      .bind(p.pilotId),
    db
      .prepare(
        "INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM hosted_schema WHERE version=1 AND budget_namespace=?) THEN 1 ELSE 0 END)",
      )
      .bind(g, p.pilotId),
    db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(g),
  ]);
}
export async function ensureBudgetNamespace(db: D1Database, p: HostedPolicy) {
  const row = await db
    .prepare("SELECT budget_namespace FROM hosted_schema WHERE version=1")
    .first<{ budget_namespace: string | null }>();
  if (row?.budget_namespace === null)
    await db
      .prepare(
        "UPDATE hosted_schema SET budget_namespace=? WHERE version=1 AND budget_namespace IS NULL",
      )
      .bind(p.pilotId)
      .run();
  await assertBudgetNamespace(db, p);
}
export async function provisionHostedInvite(
  db: D1Database,
  p: HostedPolicy,
  input: { id: Hex; token: string; allowanceId: Hex; expiresAt: number },
  now: number,
  context?: HostedSchemaContext,
) {
  const { id, token: secret, allowanceId, expiresAt } = input;
  insist(
    sharedBytes32(id) !== HOSTED_NO_INVITE_ID &&
      sharedBytes32(allowanceId) !== HOSTED_NO_INVITE_ID,
    "invalid_invite_identifier",
  );
  insist(/^[0-9a-f]{64}(?![\s\S])/.test(secret), "invalid_invite_token");
  insist(
    Number.isSafeInteger(expiresAt) &&
      expiresAt > now &&
      expiresAt - now <= p.inviteMaxSeconds,
    "invalid_invite_expiry",
  );
  await assertHostedSchema(db, context);
  await initializeBudgetNamespace(db, p);
  await db
    .prepare(
      "INSERT INTO hosted_invites(id,token_hash,allowance_id,policy_hash,expires_at) VALUES(?,?,?,?,?)",
    )
    .bind(id, hashText(secret), allowanceId, policyHash(p), expiresAt)
    .run();
}
export async function assertBudgetNamespace(db: D1Database, p: HostedPolicy) {
  const row = await db
    .prepare("SELECT budget_namespace FROM hosted_schema WHERE version=1")
    .first<{ budget_namespace: string | null }>();
  insist(
    row?.budget_namespace === p.pilotId,
    "hosted_budget_namespace_changed",
    503,
  );
}
export async function revokeHostedInvite(db: D1Database, id: Hex, context?: HostedSchemaContext) {
  await assertHostedSchema(db, context);
  await db
    .prepare("UPDATE hosted_invites SET revoked=1 WHERE id=?")
    .bind(sharedBytes32(id))
    .run();
}
export async function findInvite(
  db: D1Database,
  secret: string,
  p: HostedPolicy,
  now: number,
) {
  insist(/^[0-9a-f]{64}(?![\s\S])/.test(secret), "invite_unavailable", 403);
  const i = await db
    .prepare("SELECT * FROM hosted_invites WHERE token_hash=?")
    .bind(hashText(secret))
    .first<Invite>();
  insist(
    i &&
      i.revoked === 0 &&
      i.expires_at > now &&
      i.policy_hash === policyHash(p),
    "invite_unavailable",
    403,
  );
  return i;
}
export async function loadEnrollment(db: D1Database, id: Hex) {
  const row = await db
    .prepare("SELECT body FROM hosted_preparations WHERE id=?")
    .bind(sharedBytes32(id))
    .first<{ body: string }>();
  insist(row, "enrollment_not_found", 404);
  return parseEnrollment(JSON.parse(row.body));
}
export async function loadOriginalPolicy(db: D1Database, e: Enrollment) {
  const row = await db
    .prepare("SELECT policy FROM hosted_preparations WHERE id=?")
    .bind(e.id)
    .first<{ policy: string }>();
  insist(row, "enrollment_not_found", 404);
  const p = parsePolicyDocument(JSON.parse(row.policy));
  insist(policyHash(p) === e.policyHash, "saved_policy_changed", 503);
  return p;
}
export async function savePreparation(
  db: D1Database,
  e: Enrollment,
  requestHash: Hex,
  p: HostedPolicy,
) {
  const body = canonical(enrollmentDocument(e));
  await db
    .prepare(
      "INSERT INTO hosted_preparations(id,invite_id,request_hash,body,policy) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(e.id, e.inviteId, requestHash, body, canonical(policyDocument(p)))
    .run();
  const row = await db
    .prepare(
      "SELECT request_hash,body FROM hosted_preparations WHERE id=?",
    )
    .bind(e.id)
    .first<{ request_hash: string; body: string }>();
  insist(row?.request_hash === requestHash, "invite_preparation_conflict", 409);
  return parseEnrollment(JSON.parse(row.body));
}
export function activeCondition(e: Enrollment, now: number) {
  if (e.inviteId === null)
    return {
      clause: "? > ?",
      binds: [e.expiresAt, now],
      code: "enrollment_inactive",
    };
  return {
    clause:
      "EXISTS(SELECT 1 FROM hosted_invites WHERE id=? AND revoked=0 AND expires_at>? AND policy_hash=?) AND ? > ?",
    binds: [e.inviteId, now, e.policyHash, e.expiresAt, now],
    code: "enrollment_inactive",
  };
}
function guard(db: D1Database, e: Enrollment, now: number, id: string) {
  const c = activeCondition(e, now);
  return db
    .prepare(
      `INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN ${c.clause} THEN 1 ELSE 0 END)`,
    )
    .bind(id, ...c.binds);
}
export async function requireActive(
  db: D1Database,
  e: Enrollment,
  now: number,
) {
  const c = activeCondition(e, now);
  const r = await db
    .prepare(`SELECT CASE WHEN ${c.clause} THEN 1 ELSE 0 END AS ok`)
    .bind(...c.binds)
    .first<{ ok: number }>();
  insist(r?.ok === 1, "enrollment_inactive", 409);
}
export async function redeemEnrollment(
  db: D1Database,
  e: Enrollment,
  now: number,
) {
  const g = token();
  await db.batch([
    guard(db, e, now, g),
    db
      .prepare(
        "INSERT INTO hosted_enrollments(id,invite_id,allowance_id,community_id,installation_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(
        e.id,
        e.inviteId,
        e.allowanceId,
        e.plan.profile.communityId,
        e.plan.profile.installationId,
      ),
    db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(g),
  ]);
}
export interface HostedOperation {
  id: string;
  enrollment_id: Hex;
  kind: "registration" | "topup";
  sender: Hex;
  chain_id: number;
  nonce: number;
  payload: string;
  request_hash: Hex;
  reservation: string;
  raw: Hex | null;
  tx_hash: Hex | null;
  state: "planned" | "signed" | "dispatched" | "consumed" | "reverted";
  receipt: string | null;
  attempts: number;
  last_dispatch: number | null;
}
export async function getOperation(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM hosted_operations WHERE id=?")
    .bind(id)
    .first<HostedOperation>();
}
export async function allOperations(db: D1Database, id: Hex) {
  return (
    await db
      .prepare(
        "SELECT * FROM hosted_operations WHERE enrollment_id=? ORDER BY id",
      )
      .bind(id)
      .all<HostedOperation>()
  ).results;
}
export async function createOperation(
  db: D1Database,
  e: Enrollment,
  now: number,
  input: Omit<
    HostedOperation,
    | "nonce"
    | "raw"
    | "tx_hash"
    | "state"
    | "receipt"
    | "attempts"
    | "last_dispatch"
  >,
  pendingNonce: number,
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await getOperation(db, input.id);
    if (existing) {
      insist(
        existing.request_hash === input.request_hash &&
          existing.payload === input.payload &&
          existing.reservation === input.reservation,
        "hosted_operation_conflict",
        409,
      );
      return existing;
    }
    const pending = await db
      .prepare(
        "SELECT id FROM hosted_operations WHERE sender=? AND chain_id=? AND state IN('planned','signed') AND id<>? LIMIT 1",
      )
      .bind(input.sender, input.chain_id, input.id)
      .first();
    insist(!pending, "hosted_sender_unresolved_original", 409);
    const row = await db
      .prepare(
        "SELECT MAX(nonce) AS n FROM hosted_operations WHERE sender=? AND chain_id=?",
      )
      .bind(input.sender, input.chain_id)
      .first<{ n: number | null }>();
    // A dispatched row may represent a crash before RPC. Do not queue a new
    // nonce until the actual node observes that predecessor consuming/pending.
    if (row?.n !== null && row?.n !== undefined && pendingNonce <= row.n) {
      // A concurrent exact caller may have won after our initial read.
      const winner = await getOperation(db, input.id);
      if (winner) {
        insist(
          winner.request_hash === input.request_hash &&
            winner.payload === input.payload &&
            winner.reservation === input.reservation,
          "hosted_operation_conflict",
          409,
        );
        return winner;
      }
      insist(false, "hosted_sender_nonce_unobserved", 409);
    }
    const nonce = Math.max(pendingNonce, (row?.n ?? -1) + 1),
      g = token();
    insist(Number.isSafeInteger(nonce) && nonce >= 0, "invalid_nonce");
    try {
      await db.batch([
        guard(db, e, now, g),
        db
          .prepare(
            "INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN NOT EXISTS(SELECT 1 FROM hosted_operations WHERE sender=? AND chain_id=? AND state IN('planned','signed') AND id<>?) THEN 1 ELSE 0 END)",
          )
          .bind(g + ":sender", input.sender, input.chain_id, input.id),
        db
          .prepare(
            "INSERT INTO hosted_operations(id,enrollment_id,kind,sender,chain_id,nonce,payload,request_hash,reservation) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            input.id,
            input.enrollment_id,
            input.kind,
            input.sender,
            input.chain_id,
            nonce,
            input.payload,
            input.request_hash,
            input.reservation,
          ),
        db
          .prepare("DELETE FROM transaction_guards WHERE guard_id IN(?,?)")
          .bind(g, g + ":sender"),
      ]);
      return (await getOperation(db, input.id))!;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("UNIQUE constraint failed: hosted_operations")
      )
        throw error;
    }
  }
  insist(false, "hosted_nonce_busy", 409);
}
export function operationBudgetKeys(
  p: HostedPolicy,
  e: Enrollment,
  kind: HostedOperation["kind"],
  recipient: string,
): BudgetKey[] {
  const period = "lifetime",
    asset = `native:${e.plan.profile.chainId}`,
    global = `hosted:${p.pilotId}:global`;
  if (kind === "registration")
    return [
      global,
      ...(e.allowanceId === null
        ? []
        : [`hosted:${p.pilotId}:community:${e.allowanceId}`]),
    ].map((scope) => ({ scope, period, asset }));
  insist(e.allowanceId !== null, "hosted_topup_allowance_required", 409);
  return [
    global,
    `hosted:${p.pilotId}:community:${e.allowanceId}`,
    `hosted:${p.pilotId}:recipient:${recipient}`,
  ].map((scope) => ({ scope, period, asset }));
}
export async function reserveOperation(
  db: D1Database,
  p: HostedPolicy,
  e: Enrollment,
  op: HostedOperation,
  recipient: string,
  now: number,
) {
  const keys = operationBudgetKeys(p, e, op.kind, recipient),
    caps =
      op.kind === "registration"
        ? [p.globalCeiling, ...(keys.length === 1 ? [] : [p.communityCeiling])]
        : [p.globalCeiling, p.communityCeiling, p.recipientCeiling];
  for (let i = 0; i < keys.length; i++)
    await configureBudget(db, keys[i]!, caps[i]!);
  await reserveBudget(
    db,
    op.id,
    op.request_hash,
    keys,
    op.reservation,
    activeCondition(e, now),
  );
}
export async function persistSigned(
  db: D1Database,
  op: HostedOperation,
  raw: Hex,
  hash: Hex,
) {
  await db
    .prepare(
      "UPDATE hosted_operations SET raw=?,tx_hash=?,state='signed' WHERE id=? AND state='planned' AND raw IS NULL AND request_hash=?",
    )
    .bind(raw, hash, op.id, op.request_hash)
    .run();
  const saved = (await getOperation(db, op.id))!;
  // A concurrent signer may produce another valid signature; only the saved
  // original is allowed to proceed. No overwrite and no second nonce.
  insist(
    saved.raw !== null && saved.tx_hash !== null,
    "signed_original_not_durable",
    503,
  );
  return saved;
}
export async function claimDispatch(
  db: D1Database,
  e: Enrollment,
  op: HostedOperation,
  now: number,
  p: HostedPolicy,
) {
  const c = activeCondition(e, now);
  const r = await db
    .prepare(
      `UPDATE hosted_operations SET state='dispatched',attempts=attempts+1,last_dispatch=? WHERE id=? AND state IN('signed','dispatched') AND tx_hash=? AND attempts=? AND attempts<? AND (last_dispatch IS NULL OR last_dispatch<=?) AND ${c.clause}`,
    )
    .bind(
      now,
      op.id,
      op.tx_hash,
      op.attempts,
      p.maxBroadcastAttempts,
      now - p.broadcastRetrySeconds,
      ...c.binds,
    )
    .run();
  return r.meta.changes === 1;
}
export async function settleOperation(
  db: D1Database,
  p: HostedPolicy,
  e: Enrollment,
  op: HostedOperation,
  recipient: string,
  cost: bigint,
  state: "consumed" | "reverted",
  receipt: unknown,
) {
  insist(cost <= wei(op.reservation), "receipt_exceeds_reserved_budget", 503);
  const body = canonical(receipt);
  await db
    .prepare(
      "UPDATE hosted_operations SET state=?,receipt=? WHERE id=? AND state='dispatched' AND tx_hash=?",
    )
    .bind(state, body, op.id, op.tx_hash)
    .run();
  const saved = (await getOperation(db, op.id))!;
  insist(
    saved.state === state && saved.receipt === body,
    "hosted_settlement_conflict",
    503,
  );
  // Safe is not irreversible finality. Charge the full worst-case bound,
  // including reverts; never reuse headroom after a possible reorg/reinclusion.
  // Terminal evidence precedes settlement; storage failure keeps the full hold.
  await settleBudget(
    db,
    op.id,
    operationBudgetKeys(p, e, op.kind, recipient),
    op.reservation,
  );
}
