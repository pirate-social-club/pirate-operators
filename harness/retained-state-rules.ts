// Rule-based successor of the pinned first-song retained state. A reviewed
// public baseline records each pinned row; a release then accepts the live
// tables only if every pinned row is retained with its immutable columns
// unchanged and its operational columns moved legally, and every new row is
// growth that owner publishing is authorized to produce under the active
// owner grant. Every column of every checked table is classified here; an
// unclassified or missing column fails closed.
import { canonical, hashJson, insist, object } from "../packages/community/common.ts";
import {
  ownerBudgetCeiling,
  ownerBudgetKey,
  validateOwnerGrant,
  type OwnerBudgetAsset,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { pinOperationId } from "../packages/release/artifacts.ts";
import {
  ownerReleaseKey,
  ownerReleaseRoles,
} from "../packages/release/owner-release.ts";

export type Side = "application" | "managed";
type Row = Record<string, unknown>;
export type Rows = Record<string, Row[]>;

/** Never changes once written. */
const I = "immutable";
/** Lease and execution tokens: may change, never recorded. */
const V = "volatile";
/** Operational value with no ordering, such as an error code. */
const F = "free";
/** An integer or decimal amount that never decreases. */
const M = "monotonic";
/** Null until written once, then fixed. */
const S = "setOnce";
interface Machine {
  /** Forward order; a later state never moves to an earlier one. */
  order: readonly string[];
  /** Never left once reached. */
  terminal: readonly string[];
  /** Recovery states, entered from and left to any non-terminal state. */
  side?: readonly string[];
}
type Kind = typeof I | typeof V | typeof F | typeof M | typeof S | Machine;
interface TableRule {
  key: readonly string[];
  columns: Record<string, Kind>;
  /** A pinned row may be absent once its expires_at (seconds) has passed. */
  expiring?: boolean;
}

const submissionState: Machine = {
  order: ["reserved", "uploading", "uploaded", "sealed"],
  terminal: ["sealed"],
};
const jobPhase: Machine = {
  order: [
    "admission",
    "pin_audio",
    "pin_lyrics",
    "registration",
    "pin_manifest",
    "publication",
    "published",
  ],
  terminal: ["published", "blocked", "failed"],
  side: ["held", "needs_evidence", "uncertain"],
};
const operationStatus: Machine = {
  order: ["planned", "prepared", "running", "confirmed"],
  terminal: ["confirmed", "failed"],
  side: ["uncertain"],
};
const stemState: Machine = {
  order: ["reserved", "uploading", "sealed"],
  terminal: ["sealed"],
};
const reservationStatus: Machine = {
  order: ["reserved", "settled"],
  terminal: ["settled"],
};
const admissionState: Machine = {
  order: ["queued", "running", "complete"],
  terminal: ["complete", "rejected"],
  side: ["held", "uncertain"],
};
const callState: Machine = {
  order: ["planned", "running", "received", "validated"],
  terminal: ["validated"],
  side: ["uncertain"],
};
const pinState: Machine = {
  order: ["prepared", "running", "confirmed"],
  terminal: ["confirmed"],
  side: ["uncertain"],
};
const registrationState: Machine = {
  order: ["planned", "prepared", "running", "confirmed"],
  terminal: ["confirmed"],
  side: ["uncertain"],
};
const budgets: TableRule = {
  key: ["scope", "period", "asset"],
  // reserved is checked against the reservations below.
  columns: {
    scope: I,
    period: I,
    asset: I,
    ceiling: I,
    reserved: F,
    spent: M,
    version: M,
  },
};
const reservations: TableRule = {
  key: ["reservation_id", "scope", "period", "asset"],
  columns: {
    reservation_id: I,
    scope: I,
    period: I,
    asset: I,
    request_hash: I,
    amount: I,
    actual: S,
    status: reservationStatus,
  },
};

export const retainedStateRules: Record<Side, Record<string, TableRule>> = {
  application: {
    community_accounts: {
      key: ["account_id"],
      columns: { account_id: I, author_id: I, created_at: I },
    },
    credential_bindings: {
      key: ["binding_id"],
      columns: {
        binding_id: I,
        account_id: I,
        namespace: I,
        network: I,
        subject: I,
        created_at: I,
      },
    },
    // receipt_json and verified_at are rewritten on creator re-verification,
    // which owner deployments refuse (creator_connection_unavailable), so the
    // pinned binding is immutable here.
    creator_bindings: {
      key: ["account_id"],
      columns: {
        account_id: I,
        service_origin: I,
        credential_ref: I,
        sui_address: I,
        dwallet_id: I,
        capability_id: I,
        share_id: I,
        evm_address: I,
        receipt_json: I,
        verified_at: I,
      },
    },
    media_submissions: {
      key: ["submission_id"],
      columns: {
        submission_id: I,
        account_id: I,
        author_id: I,
        post_id: I,
        idempotency_key: I,
        request_hash: I,
        metadata_json: I,
        captured_wallet: I,
        creator_json: I,
        audio_sha256: I,
        audio_bytes: I,
        // Replaced when an expired upload lease is taken over.
        object_key: F,
        upload_state: submissionState,
        upload_lease: V,
        upload_lease_until: V,
        object_etag: S,
        created_at: I,
        sealed_at: S,
      },
    },
    publication_jobs: {
      key: ["job_id"],
      columns: {
        job_id: I,
        submission_id: I,
        input_hash: I,
        authority_json: I,
        phase: jobPhase,
        progress_json: F,
        revision: M,
        lease_token: V,
        lease_until: V,
        due_at: F,
        attempts: M,
        error_code: F,
        created_at: I,
        updated_at: M,
      },
    },
    external_operations: {
      key: ["operation_id"],
      columns: {
        operation_id: I,
        job_id: I,
        step: I,
        request_hash: I,
        request_json: I,
        status: operationStatus,
        prepared_json: S,
        provider_id: S,
        result_json: S,
        error_code: F,
        started_at: S,
        completed_at: S,
      },
    },
    media_stems: {
      key: ["submission_id", "slot"],
      columns: {
        submission_id: I,
        slot: I,
        sha256: I,
        byte_length: I,
        state: stemState,
        // Replaced when an expired upload lease is taken over.
        object_key: F,
        object_etag: S,
        duration_ms: S,
        lease_token: V,
        lease_until: V,
        created_at: I,
        sealed_at: S,
      },
    },
    publication_amendments: {
      key: ["job_id"],
      columns: {
        job_id: I,
        amendment_sha256: I,
        signed_json: I,
        predecessor_operation_id: I,
        successor_operation_id: I,
        created_at: I,
      },
    },
    external_operation_reconciliations: {
      key: ["operation_id", "proof_sha256"],
      columns: {
        operation_id: I,
        proof_sha256: I,
        proof_json: I,
        observed_at: I,
      },
    },
    moderation_input_capabilities: {
      key: ["capability_hash"],
      expiring: true,
      columns: {
        capability_hash: I,
        submission_id: I,
        input_kind: I,
        sha256: I,
        byte_length: I,
        expires_at: I,
      },
    },
    spending_budgets: budgets,
    spending_reservations: reservations,
  },
  managed: {
    managed_admissions: {
      key: ["admission_id"],
      columns: {
        admission_id: I,
        community_id: I,
        submission_id: I,
        job_id: I,
        request_hash: I,
        // Transport capabilities are renewed under the fixed request_hash.
        // enqueueAdmission rewrites it without a state guard, so a re-admit
        // of a pinned terminal admission would trip the frozen rule; no code
        // path re-admits a published job today.
        request_json: F,
        authority_json: I,
        budget_period: I,
        state: admissionState,
        lease_token: V,
        lease_until: V,
        prepared_json: S,
        // Rewritten when a held or uncertain admission completes later.
        result_json: F,
        error_code: F,
        created_at: I,
        updated_at: M,
      },
    },
    moderation_provider_calls: {
      key: ["call_id"],
      columns: {
        call_id: I,
        admission_id: I,
        kind: I,
        request_hash: I,
        request_json: I,
        state: callState,
        execution_token: V,
        response_json: S,
        result_json: S,
        provider_id: S,
        started_at: S,
        completed_at: S,
      },
    },
    spending_budgets: budgets,
    spending_reservations: reservations,
    managed_releases: {
      key: ["grant_hash"],
      columns: {
        grant_hash: I,
        request_hash: I,
        context_json: I,
        admission_sha256: I,
        created_at: I,
      },
    },
    funded_pins: {
      key: ["operation_id"],
      columns: {
        operation_id: I,
        request_hash: I,
        grant_hash: I,
        intent_json: I,
        state: pinState,
        provider_receipt_json: S,
        result_json: S,
        created_at: I,
      },
    },
    funded_registrations: {
      key: ["operation_id"],
      columns: {
        operation_id: I,
        request_hash: I,
        grant_hash: I,
        state: registrationState,
        prepared_json: S,
        result_json: S,
        created_at: I,
      },
    },
    curated_admissions: {
      key: ["admission_id"],
      columns: {
        admission_id: I,
        original_admission_id: I,
        amendment_sha256: I,
        signed_json: I,
        result_json: I,
        created_at: I,
      },
    },
    moderation_request_nonces: {
      key: ["community_id", "nonce"],
      columns: { community_id: I, nonce: I, wire_hash: I, expires_at: I },
    },
  },
};

const fail = (code: string): never => {
  insist(false, code, 409);
  throw new Error(code);
};
const isMachine = (kind: Kind): kind is Machine => typeof kind === "object";
const named = (rule: TableRule, kind: (k: Kind) => boolean) =>
  Object.entries(rule.columns)
    .filter(([, k]) => kind(k))
    .map(([c]) => c);
const pick = (row: Row, columns: readonly string[]) =>
  columns.map((c) => row[c] ?? null);
const keyOf = (rule: TableRule, row: Row) => hashJson(pick(row, rule.key));
const budgetKeyOf = (row: Row) => hashJson(pick(row, budgets.key));
/** Plain values recorded for pinned rows; never private content or tokens. */
const plainColumns = (table: string, rule: TableRule) => [
  ...named(rule, (k) => isMachine(k) || k === M),
  ...(table === "spending_budgets"
    ? ["scope", "period", "asset", "ceiling", "reserved"]
    : table === "spending_reservations"
      ? ["amount", "actual"]
      : []),
  ...(rule.expiring ? ["expires_at"] : []),
];

function assertColumns(side: Side, table: string, row: Row) {
  const rule = retainedStateRules[side][table]!;
  insist(
    canonical(Object.keys(row).sort()) ===
      canonical(Object.keys(rule.columns).sort()),
    "retained_state_column_unclassified",
    409,
  );
}

export interface BaselineRow {
  key: string;
  immutable: string;
  setOnce: Record<string, string | null>;
  values: Record<string, unknown>;
  budget?: string;
  /** Digest of the free columns of a row in a terminal state: frozen. */
  frozen?: string;
}
export type SideBaseline = Record<string, BaselineRow[]>;

const terminal = (rule: TableRule, row: Row) =>
  Object.entries(rule.columns).some(
    ([c, k]) => isMachine(k) && k.terminal.includes(String(row[c])),
  );
const freeDigest = (rule: TableRule, row: Row) =>
  hashJson(pick(row, named(rule, (k) => k === F)));

/**
 * The public per-row baseline of one side's pinned rows. The rows must
 * themselves be valid: legal states, integer counters, and every budget equal
 * to its reservations.
 */
export function deriveSideBaseline(side: Side, rows: Rows): SideBaseline {
  const out: SideBaseline = {};
  for (const [table, rule] of Object.entries(retainedStateRules[side])) {
    const list = rows[table];
    insist(Array.isArray(list), "retained_state_table_missing", 409);
    const immutable = named(rule, (k) => k === I),
      setOnce = named(rule, (k) => k === S),
      plain = plainColumns(table, rule);
    out[table] = list.map((row) => {
      assertColumns(side, table, row);
      assertNewValues(rule, row);
      return {
        key: keyOf(rule, row),
        immutable: hashJson(pick(row, immutable)),
        setOnce: Object.fromEntries(
          setOnce.map((c) => [c, row[c] == null ? null : hashJson(row[c])]),
        ),
        values: Object.fromEntries(plain.map((c) => [c, row[c] ?? null])),
        ...(table.startsWith("spending_") ? { budget: budgetKeyOf(row) } : {}),
        ...(terminal(rule, row) ? { frozen: freeDigest(rule, row) } : {}),
      };
    });
    insist(
      new Set(out[table]!.map((r) => r.key)).size === out[table]!.length,
      "retained_state_baseline_key_duplicate",
      409,
    );
  }
  assertBudgets(rows);
  return out;
}

function transition(machine: Machine, before: unknown, after: unknown) {
  const legal = [...machine.order, ...machine.terminal, ...(machine.side ?? [])];
  insist(legal.includes(String(after)), "retained_state_value_invalid", 409);
  if (before === after) return;
  const from = String(before),
    to = String(after);
  insist(
    !machine.terminal.includes(from) &&
      (machine.side?.includes(from) ||
        machine.side?.includes(to) ||
        machine.terminal.includes(to) ||
        machine.order.indexOf(to) > machine.order.indexOf(from)),
    "retained_state_transition_invalid",
    409,
  );
}
const integer = (value: unknown) => {
  insist(
    typeof value === "number" && Number.isSafeInteger(value),
    "retained_state_value_invalid",
    409,
  );
  return value as number;
};
const amount = (value: unknown) => {
  insist(
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value),
    "retained_state_value_invalid",
    409,
  );
  return BigInt(value as string);
};

/** An integer column, or a decimal amount column such as spent. */
const counter = (value: unknown) =>
  typeof value === "string" ? amount(value) : BigInt(integer(value));

/** A pinned row: immutable columns unchanged, operational ones moved legally. */
function assertPinned(rule: TableRule, row: Row, pinned: BaselineRow) {
  insist(
    hashJson(pick(row, named(rule, (k) => k === I))) === pinned.immutable,
    "retained_state_immutable_changed",
    409,
  );
  if (pinned.frozen !== undefined)
    insist(
      freeDigest(rule, row) === pinned.frozen,
      "retained_state_terminal_changed",
      409,
    );
  for (const [column, digest] of Object.entries(pinned.setOnce))
    if (digest !== null)
      insist(
        row[column] != null && hashJson(row[column]) === digest,
        "retained_state_set_once_changed",
        409,
      );
  for (const [column, kind] of Object.entries(rule.columns)) {
    if (isMachine(kind))
      transition(kind, pinned.values[column], row[column]);
    else if (kind === M)
      insist(
        counter(row[column]) >= counter(pinned.values[column]),
        "retained_state_counter_decreased",
        409,
      );
  }
}
/** A new row: legal state values and integer counters. */
function assertNewValues(rule: TableRule, row: Row) {
  for (const [column, kind] of Object.entries(rule.columns)) {
    if (isMachine(kind)) transition(kind, row[column], row[column]);
    else if (kind === M) counter(row[column]);
  }
}

const OWNER_ASSETS: readonly OwnerBudgetAsset[] = [
  "songs",
  "pin_adds",
  "pin_bytes",
  "recognition_requests",
  "post_fee_wei",
];
const lower = (value: unknown) => String(value).toLowerCase();

/**
 * Accepts the live tables of one side against its pinned baseline under the
 * active owner grant's scope. Growth is compared with the baseline only, so a
 * row created after the baseline is checked for authorization and valid
 * values, not against its own earlier state. Returns growth rows per table.
 */
export function assertRetainedRows(
  side: Side,
  rows: Rows,
  baseline: SideBaseline,
  grantInput: unknown,
  nowSeconds: number,
  /** When the baseline was captured; every new owner row is later. */
  capturedAtMs: number,
) {
  const grant = validateOwnerGrant(grantInput),
    rules = retainedStateRules[side];
  insist(Number.isSafeInteger(capturedAtMs), "retained_state_baseline_invalid", 409);
  const fresh: Record<string, Row[]> = {},
    pinnedBudget = new Map<string, Record<string, unknown>>();
  for (const [table, rule] of Object.entries(rules)) {
    const list = rows[table],
      pinned = baseline[table];
    insist(
      Array.isArray(list) && Array.isArray(pinned),
      "retained_state_table_missing",
      409,
    );
    const live = new Map<string, Row>();
    for (const row of list) {
      assertColumns(side, table, row);
      const key = keyOf(rule, row);
      insist(!live.has(key), "retained_state_key_duplicate", 409);
      live.set(key, row);
    }
    for (const entry of pinned) {
      const row = live.get(entry.key);
      if (!row) {
        insist(
          !!rule.expiring && integer(entry.values.expires_at) <= nowSeconds,
          "retained_state_pinned_row_missing",
          409,
        );
        continue;
      }
      assertPinned(rule, row, entry);
      live.delete(entry.key);
      if (table === "spending_budgets") pinnedBudget.set(entry.key, entry.values);
    }
    fresh[table] = [...live.values()];
    for (const row of fresh[table]!) assertNewValues(rule, row);
  }
  (side === "application" ? authorizeApplication : authorizeManaged)(
    rows,
    fresh,
    grant,
    pinnedBudget,
    capturedAtMs,
    nowSeconds,
  );
  assertBudgets(rows);
  return Object.fromEntries(
    Object.entries(fresh).map(([table, list]) => [table, list.length]),
  );
}

/** Every budget equals its reservations and stays within its ceiling. */
function assertBudgets(rows: Rows) {
  const totals = new Map<string, { reserved: bigint; spent: bigint }>();
  for (const r of rows.spending_reservations!) {
    const key = budgetKeyOf(r),
      total = totals.get(key) ?? { reserved: 0n, spent: 0n };
    if (r.status === "reserved") {
      insist(r.actual == null, "retained_state_reservation_invalid", 409);
      total.reserved += amount(r.amount);
    } else {
      const actual = amount(r.actual);
      insist(actual <= amount(r.amount), "retained_state_reservation_invalid", 409);
      total.spent += actual;
    }
    totals.set(key, total);
  }
  const keys = new Set<string>();
  for (const b of rows.spending_budgets!) {
    const key = budgetKeyOf(b),
      total = totals.get(key) ?? { reserved: 0n, spent: 0n };
    keys.add(key);
    insist(
      amount(b.reserved) === total.reserved &&
        amount(b.spent) === total.spent &&
        total.reserved + total.spent <= amount(b.ceiling),
      "retained_state_budget_invalid",
      409,
    );
  }
  for (const key of totals.keys())
    insist(keys.has(key), "retained_state_budget_missing", 409);
}

const unauthorized = () => fail("retained_state_row_unauthorized");
/** Clock tolerance between the service and the release runner. */
const SKEW_MS = 300_000;
/** Created after the baseline capture and not in the future. */
const later = (capturedAtMs: number, nowSeconds: number, ms: unknown) =>
  integer(ms) >= capturedAtMs && integer(ms) <= nowSeconds * 1000 + SKEW_MS;
const windowOf = (period: unknown) => {
  const m = /^([1-9][0-9]{0,15})-([1-9][0-9]{0,15})$/.exec(String(period));
  return m && Number(m[1]) < Number(m[2])
    ? { from: Number(m[1]), until: Number(m[2]) }
    : undefined;
};
/**
 * Owner windows a release accepts: the active grant's, and earlier windows of
 * replacement grants for the same scope. claimOwnerWindow only advances to a
 * later, non-overlapping window, and no owner row predates the baseline, so an
 * earlier window ends after the capture and at or before the active window
 * starts, and no two overlap. The periods come from the owner-scope rows.
 */
function ownerWindows(
  grant: OwnerBudgetGrant,
  rows: Rows,
  capturedAtMs: number,
) {
  const scope = ownerBudgetKey(grant, "songs").scope,
    current = ownerBudgetKey(grant, "songs").period;
  const periods = new Set(
    [...rows.spending_budgets!, ...rows.spending_reservations!]
      .filter((r) => r.scope === scope)
      .map((r) => String(r.period)),
  );
  const earlier = [...periods]
    .filter((p) => p !== current)
    .map((p) => {
      const w = windowOf(p);
      insist(
        !!w &&
          w.until <= grant.validFrom &&
          w.until * 1000 > capturedAtMs - SKEW_MS,
        "retained_state_row_unauthorized",
        409,
      );
      return w!;
    })
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < earlier.length; i++)
    insist(
      earlier[i]!.from >= earlier[i - 1]!.until,
      "retained_state_row_unauthorized",
      409,
    );
  return new Set([current, ...earlier.map((w) => `${w.from}-${w.until}`)]);
}
/** The owner asset of a row in the grant's owner scope, in an accepted window. */
const ownerAsset = (grant: OwnerBudgetGrant, row: Row) =>
  row.scope === ownerBudgetKey(grant, "songs").scope && windowOf(row.period)
    ? OWNER_ASSETS.find((asset) => row.asset === asset)
    : undefined;
/** validateOwnerGrant's bounds, for windows of earlier grants. */
const OWNER_MAXIMA: Record<OwnerBudgetAsset, bigint> = {
  songs: 100n,
  pin_adds: 1000n,
  pin_bytes: 10n * 1024n ** 3n,
  recognition_requests: 1000n,
  post_fee_wei: 100000000000000000n,
};
/**
 * A new owner budget row. In the active window its ceiling is the grant's;
 * an earlier window's ceiling was bound by its own grant when that window was
 * claimed, and is held to the grant validator's bounds here.
 */
function assertOwnerBudget(grant: OwnerBudgetGrant, row: Row) {
  const asset = ownerAsset(grant, row);
  if (!asset) return false;
  if (row.period === ownerBudgetKey(grant, asset).period)
    insist(
      row.ceiling === ownerBudgetCeiling(grant, asset),
      "retained_state_budget_invalid",
      409,
    );
  else
    insist(
      amount(row.ceiling) > 0n && amount(row.ceiling) <= OWNER_MAXIMA[asset],
      "retained_state_budget_invalid",
      409,
    );
  return true;
}
const ids = (list: Row[] | undefined, column: string) =>
  new Set((list ?? []).map((r) => String(r[column])));

/**
 * New application rows: learner accounts and their MOSS bindings; the owner's
 * own submissions (no creator, captured from the owner wallet by an account
 * bound to it) created after the baseline, and rows reached from them; and
 * owner-scope budgets, whose only reservations here are post fees of the
 * owner's own operations. Paid work is bounded by the budgets, not counted
 * here.
 */
function authorizeApplication(
  rows: Rows,
  fresh: Rows,
  grant: OwnerBudgetGrant,
  _pinned: unknown,
  capturedAtMs: number,
  nowSeconds: number,
) {
  ownerWindows(grant, rows, capturedAtMs);
  const wallet = lower(grant.ownerWallet),
    accounts = ids(rows.community_accounts, "account_id");
  for (const b of fresh.credential_bindings!)
    if (
      b.namespace !== "moss" ||
      b.network !== 6343 ||
      !accounts.has(String(b.account_id))
    )
      unauthorized();
  if (fresh.creator_bindings!.length || fresh.publication_amendments!.length)
    unauthorized();
  const ownerAccounts = new Set(
    rows.credential_bindings!
      .filter((b) => lower(b.subject) === wallet)
      .map((b) => String(b.account_id)),
  );
  for (const s of fresh.media_submissions!)
    if (
      s.creator_json !== "null" ||
      lower(s.captured_wallet) !== wallet ||
      !ownerAccounts.has(String(s.account_id)) ||
      !later(capturedAtMs, nowSeconds, s.created_at)
    )
      unauthorized();
  const submissions = ids(fresh.media_submissions, "submission_id");
  for (const table of [
    "publication_jobs",
    "media_stems",
    "moderation_input_capabilities",
  ])
    for (const r of fresh[table]!)
      if (!submissions.has(String(r.submission_id))) unauthorized();
  const jobs = ids(fresh.publication_jobs, "job_id");
  for (const o of fresh.external_operations!)
    if (!jobs.has(String(o.job_id))) unauthorized();
  const operations = ids(fresh.external_operations, "operation_id");
  for (const r of fresh.external_operation_reconciliations!)
    if (!operations.has(String(r.operation_id))) unauthorized();
  // Claiming an owner window configures all five owner budgets at once.
  for (const b of fresh.spending_budgets!)
    if (!assertOwnerBudget(grant, b)) unauthorized();
  for (const r of fresh.spending_reservations!) {
    const id = String(r.reservation_id);
    if (
      ownerAsset(grant, r) !== "post_fee_wei" ||
      !id.endsWith(":fee") ||
      !operations.has(id.slice(0, -4))
    )
      unauthorized();
  }
}

/**
 * New managed rows: admissions requested by the owner's community after the
 * baseline, with their provider calls and nonces; owner-scope budgets; new
 * periods of an already pinned moderation budget scope at its pinned ceiling;
 * and funded pins, each needing its owner add reservation, with per-release
 * pin budgets. Each reservation is bound to its operation or owner scope.
 */
function authorizeManaged(
  rows: Rows,
  fresh: Rows,
  grant: OwnerBudgetGrant,
  pinnedBudget: Map<string, Record<string, unknown>>,
  capturedAtMs: number,
  nowSeconds: number,
) {
  const windows = ownerWindows(grant, rows, capturedAtMs);
  if (
    fresh.managed_releases!.length ||
    fresh.funded_registrations!.length ||
    fresh.curated_admissions!.length
  )
    unauthorized();
  for (const a of fresh.managed_admissions!)
    if (
      a.community_id !== grant.communityId ||
      !later(capturedAtMs, nowSeconds, a.created_at)
    )
      unauthorized();
  const admissions = ids(fresh.managed_admissions, "admission_id"),
    jobs = ids(fresh.managed_admissions, "job_id");
  for (const c of fresh.moderation_provider_calls!)
    if (!admissions.has(String(c.admission_id))) unauthorized();
  for (const n of fresh.moderation_request_nonces!)
    if (n.community_id !== grant.communityId) unauthorized();
  const calls = ids(fresh.moderation_provider_calls, "call_id");
  // Each owner job's pins are keyed by its release key, which does not
  // depend on the window, and by role: at most three operations per job.
  const releases = new Map<string, Set<string>>(),
    operations = new Map<string, string>();
  for (const jobId of jobs) {
    const key = ownerReleaseKey(grant, jobId),
      ops = new Set(ownerReleaseRoles.map((role) => pinOperationId(key, role)));
    releases.set(key, ops);
    for (const op of ops) operations.set(op, key);
  }
  // Owner pin reservations commit before their funded pin, in separate
  // writes, and a refused byte reservation leaves the add reservation behind
  // for good. So a funded pin needs its owner add reservation, never the
  // reverse.
  const ownerPins = new Set(
    rows.spending_reservations!
      .filter(
        (r) =>
          ownerAsset(grant, r) === "pin_adds" &&
          String(r.reservation_id).endsWith(":adds"),
      )
      .map((r) => String(r.reservation_id).slice(0, -5)),
  );
  for (const p of fresh.funded_pins!) {
    const op = String(p.operation_id);
    if (
      operations.get(op) !== p.grant_hash ||
      !ownerPins.has(op) ||
      !later(capturedAtMs, nowSeconds, p.created_at)
    )
      unauthorized();
  }
  const pinnedScopes = new Map<string, unknown>();
  for (const values of pinnedBudget.values())
    if (String(values.scope).startsWith("moderation:")) {
      const scope = String(values.scope);
      if (pinnedScopes.has(scope) && pinnedScopes.get(scope) !== values.ceiling)
        fail("retained_state_budget_invalid");
      pinnedScopes.set(scope, values.ceiling);
    }
  // A per-release pin budget is configured, then reserved, then its pin is
  // inserted; each step may be the last. It belongs to a new owner job's
  // release, in an accepted owner window, and holds only that release's pin
  // operations that have their owner add reservation.
  const pinRelease = (row: Row) =>
    String(row.scope).startsWith("release:pins:") &&
    windows.has(String(row.period)) &&
    row.asset === "ipfs_add_attempts"
      ? releases.get(String(row.scope).slice("release:pins:".length))
      : undefined;
  const pinScope = (row: Row) => String(row.scope).startsWith("release:pins:");
  const pinReservation = (r: Row) =>
    !!pinRelease(r)?.has(String(r.reservation_id)) &&
    ownerPins.has(String(r.reservation_id));
  const pinBudget = (b: Row) => b.ceiling === "5" && !!pinRelease(b);
  const moderationBudget = (row: Row) =>
    pinnedScopes.has(String(row.scope)) && row.asset === "provider_requests";
  for (const b of fresh.spending_budgets!) {
    if (assertOwnerBudget(grant, b)) continue;
    if (pinBudget(b)) continue;
    if (moderationBudget(b) && b.ceiling === pinnedScopes.get(String(b.scope)))
      continue;
    unauthorized();
  }
  for (const r of fresh.spending_reservations!) {
    const id = String(r.reservation_id),
      asset = ownerAsset(grant, r);
    const authorized =
      asset === "songs"
        ? id.startsWith("owner-song:") && jobs.has(id.slice(11))
        : asset === "pin_adds"
          ? id.endsWith(":adds") && operations.has(id.slice(0, -5))
          : asset === "pin_bytes"
            ? id.endsWith(":bytes") &&
              operations.has(id.slice(0, -6)) &&
              ownerPins.has(id.slice(0, -6))
            : asset === "recognition_requests"
              ? calls.has(id)
              : asset === "post_fee_wei"
                ? false
                : pinScope(r)
                  ? pinReservation(r)
                  : moderationBudget(r) && calls.has(id);
    if (!authorized) unauthorized();
  }
}

/** The baseline record schema, checked before any comparison. */
export function readRetainedBaseline(input: unknown) {
  const b = object(input);
  insist(
    b.schema === "pirate.retained-state-baseline/1" &&
      typeof b.capturedAt === "string" &&
      Number.isSafeInteger(Date.parse(b.capturedAt)) &&
      typeof b.captureSha256 === "string" &&
      (["application", "managed"] as const).every((side) => {
        const tables = b[side];
        return (
          !!tables &&
          typeof tables === "object" &&
          canonical(Object.keys(tables).sort()) ===
            canonical(Object.keys(retainedStateRules[side]).sort()) &&
          Object.values(tables).every(Array.isArray)
        );
      }),
    "retained_state_baseline_invalid",
    409,
  );
  return b as {
    schema: string;
    capturedAt: string;
    captureSha256: string;
    predecessorStateSha256: string;
    repairSha256: string;
    application: SideBaseline;
    managed: SideBaseline;
  };
}
