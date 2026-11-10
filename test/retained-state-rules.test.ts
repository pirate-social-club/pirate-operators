import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { hashText } from "../packages/community/common.ts";
import {
  assertRetainedAgainstBaseline,
  capturePublishedState,
  retainedStateBaseline,
  publishedStateHash,
  publishedStateRepairHash,
  publishedStateRepairPath,
} from "../harness/published-state.ts";
import {
  assertRetainedRows,
  deriveSideBaseline,
  readRetainedBaseline,
  retainedStateRules,
  type Rows,
  type Side,
  type SideBaseline,
} from "../harness/retained-state-rules.ts";
import { retainedBaselineFromCapture } from "../harness/retained-state-baseline.ts";
import {
  ownerGrantDigest,
  settleOwnerBudget,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { ownerSongFixture } from "./fixtures/owner-song-job.ts";

type Fixture = Awaited<ReturnType<typeof ownerSongFixture>>;
type State = Record<Side, Rows>;
type Baseline = Record<Side, SideBaseline>;
const sides = ["application", "managed"] as const;

/** The owner fixture's managed database stops short of 0003; add it. */
async function fixture() {
  const f = await ownerSongFixture();
  const sql = await readFile(
    "apps/managed-moderation/migrations/0003_owner_curated.sql",
    "utf8",
  );
  await f.managed.db.batch(
    sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => f.managed.db.prepare(s)),
  );
  // The fixture session skips sign-in; record the MOSS binding it creates.
  await f.community.db
    .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
    .bind(
      "owner-binding",
      f.session.account_id,
      "moss",
      6343,
      f.session.wallet.toLowerCase(),
      Date.now(),
    )
    .run();
  return f;
}
const capture = async (f: Fixture): Promise<State> => ({
  application: (await capturePublishedState(f.community.db, "application"))
    .rows as Rows,
  managed: (await capturePublishedState(f.managed.db, "managed")).rows as Rows,
});
const derive = (state: State): Baseline => ({
  application: deriveSideBaseline("application", state.application),
  managed: deriveSideBaseline("managed", state.managed),
});
const nowSeconds = () => Math.floor(Date.now() / 1000);
const check = (
  grant: OwnerBudgetGrant,
  state: State,
  baseline: Baseline,
  capturedAtMs: number,
  now = nowSeconds(),
) =>
  Object.fromEntries(
    sides.map((side) => [
      side,
      assertRetainedRows(
        side,
        state[side],
        baseline[side],
        grant,
        now,
        capturedAtMs,
      ),
    ]),
  ) as Record<Side, Record<string, number>>;
const publish = async (f: Fixture, title: string, key: string) =>
  (await f.addSong(title, key)).sealed.jobId;
/** Before any owner song, as in production: learner accounts and the two
 * pinned moderation budgets with their reservations, nothing owner-scoped. */
const productionShaped = (state: State): State => {
  const empty = (side: Side) =>
    Object.fromEntries(
      Object.keys(retainedStateRules[side]).map((t) => [t, [] as Rows[string]]),
    ) as Rows;
  const moderation = (r: Record<string, unknown>) =>
    String(r.scope).startsWith("moderation:");
  return {
    application: {
      ...empty("application"),
      community_accounts: state.application.community_accounts!,
      credential_bindings: state.application.credential_bindings!,
    },
    managed: {
      ...empty("managed"),
      spending_budgets: state.managed.spending_budgets!.filter(moderation),
      spending_reservations:
        state.managed.spending_reservations!.filter(moderation),
    },
  };
};
const replacementGrant = (
  grant: OwnerBudgetGrant,
  scope: Partial<Pick<OwnerBudgetGrant, "ownerWallet" | "communityId">> = {},
) => {
  const { sha256: _, ...draft } = grant;
  const next = {
    ...draft,
    ...scope,
    validFrom: grant.expiresAt,
    expiresAt: grant.expiresAt + 3600,
  };
  return validateOwnerGrant({
    ...next,
    sha256: ownerGrantDigest({ ...next, sha256: "" }),
  });
};

test("every column of every retained-state table is classified, and nothing else", async () => {
  const f = await fixture();
  try {
    for (const [side, db] of [
      ["application", f.community.db],
      ["managed", f.managed.db],
    ] as const)
      for (const [table, rule] of Object.entries(retainedStateRules[side])) {
        const columns = (
          await db
            .prepare("SELECT name FROM pragma_table_info(?)")
            .bind(table)
            .all<{ name: string }>()
        ).results.map((c) => c.name);
        assert.deepEqual(
          columns.sort(),
          Object.keys(rule.columns).sort(),
          `${side}.${table}`,
        );
      }
  } finally {
    await f.dispose();
  }
});

test("owner uploads after the pinned baseline pass release qualification at every step without a new baseline", async () => {
  const f = await fixture();
  try {
    const start = Date.now() - 1;
    // The first published song stands in for the pinned first-song state.
    const first = await publish(f, "Pinned song", "retained-pinned-0001");
    assert.equal((await f.drive(first)).phase, "published");
    const pinned = await capture(f),
      capturedAt = Date.now(),
      baseline = derive(pinned);
    const unchanged = check(f.grant, pinned, baseline, capturedAt);
    for (const side of sides)
      assert.ok(Object.values(unchanged[side]).every((n) => n === 0));
    // A new owner upload: submission, stems, sealed job.
    const second = await publish(f, "Growth song", "retained-growth-0001");
    const sealed = check(f.grant, await capture(f), baseline, capturedAt);
    assert.equal(sealed.application.media_submissions, 1);
    assert.equal(sealed.application.publication_jobs, 1);
    // Part of the way: admission, recognition and pins.
    await f.drive(second, 3);
    const partway = check(f.grant, await capture(f), baseline, capturedAt);
    assert.ok(partway.managed.managed_admissions >= 1);
    // Published: the job has advanced past every step.
    assert.equal((await f.drive(second)).phase, "published");
    const done = await capture(f);
    const published = check(f.grant, done, baseline, capturedAt);
    assert.ok(published.managed.funded_pins >= 1);
    assert.ok(published.application.external_operations >= 1);
    // Settling the job's song reservation keeps the state acceptable.
    const songId = `owner-song:${second}`;
    assert.equal(
      done.managed.spending_reservations!.find(
        (r) => r.reservation_id === songId,
      )!.status,
      "reserved",
    );
    await settleOwnerBudget(f.managed.db, f.grant, "songs", songId, "1");
    const settled = await capture(f);
    check(f.grant, settled, baseline, capturedAt);
    assert.equal(
      settled.managed.spending_reservations!.find(
        (r) => r.reservation_id === songId,
      )!.status,
      "settled",
    );
    // The pinned owner budgets moved: counters rose within their ceilings.
    const key = (b: Record<string, unknown>) =>
      `${b.scope}|${b.period}|${b.asset}`;
    const before = new Map(
      pinned.managed.spending_budgets!.map((b) => [key(b), b]),
    );
    assert.ok(
      settled.managed.spending_budgets!.some((b) => {
        const was = before.get(key(b));
        return was && BigInt(String(b.spent)) > BigInt(String(was.spent));
      }),
    );
    // Sealed songs beyond the grant's song count still qualify: paid work is
    // bounded by the managed song budget, not by sealing.
    for (const n of [3, 4, 5])
      await publish(f, `Sealed song ${n}`, `retained-sealed-000${n}`);
    const many = await capture(f);
    assert.equal(
      check(f.grant, many, baseline, capturedAt).application.publication_jobs,
      4,
    );
    assert.ok(f.grant.limits.songs < 4);
    // From a production-shaped baseline every owner row is new on both sides.
    const fromStart = check(
      f.grant,
      many,
      derive(productionShaped(pinned)),
      start,
    );
    assert.equal(fromStart.application.publication_jobs, 5);
    assert.equal(fromStart.application.spending_budgets, 5);
    assert.ok(fromStart.managed.spending_budgets >= 5);
    assert.ok(fromStart.managed.managed_admissions >= 2);
  } finally {
    await f.dispose();
  }
});

test("a replacement grant for the same owner scope keeps earlier windows' rows authorized; another owner's grant does not", async () => {
  const f = await fixture();
  try {
    const start = Date.now() - 1;
    const first = await publish(f, "Window one", "retained-window-0001");
    assert.equal((await f.drive(first)).phase, "published");
    const live = await capture(f),
      baseline = derive(productionShaped(live));
    assert.doesNotThrow(() => check(f.grant, live, baseline, start));
    assert.doesNotThrow(() =>
      check(replacementGrant(f.grant), live, baseline, start),
    );
    for (const scope of [
      { ownerWallet: "0x" + "cd".repeat(20) },
      { communityId: "0x" + "ce".repeat(32) },
    ])
      assert.throws(
        () => check(replacementGrant(f.grant, scope), live, baseline, start),
        /retained_state_row_unauthorized/,
      );
    // A window that has not started yet is never valid.
    const future = structuredClone(live);
    const songs = future.managed.spending_budgets!.find(
      (b) => b.asset === "songs",
    )!;
    future.managed.spending_budgets!.push({
      ...songs,
      period: `${f.grant.expiresAt}-${f.grant.expiresAt + 60}`,
      reserved: "0",
      spent: "0",
      version: 0,
    });
    assert.throws(
      () => check(f.grant, future, baseline, start),
      /retained_state_row_unauthorized/,
    );
    const later = replacementGrant(f.grant);
    const variant = (
      name: string,
      mutate: (rows: State) => void,
      code: RegExp,
      grant = later,
    ) => {
      const rows = structuredClone(live);
      mutate(rows);
      assert.throws(() => check(grant, rows, baseline, start), code, name);
    };
    const songBudget = (rows: State) =>
      rows.managed.spending_budgets!.find((b) => b.asset === "songs")!;
    variant(
      "earlier window with an inflated ceiling",
      (rows) => {
        rows.managed.spending_budgets!.find(
          (b) => b.asset === "pin_adds",
        )!.ceiling = "1" + "0".repeat(70);
      },
      /retained_state_budget_invalid/,
    );
    for (const period of [
      "1-2",
      `${f.grant.validFrom - 10}-${f.grant.validFrom + 1}`,
    ])
      variant(
        `owner window ${period}`,
        (rows) => {
          rows.managed.spending_budgets!.push({
            ...songBudget(rows),
            period,
            reserved: "0",
            spent: "0",
            version: 0,
          });
        },
        /retained_state_row_unauthorized/,
        f.grant,
      );
    variant(
      "pin budget for another release",
      (rows) => {
        const pin = rows.managed.spending_budgets!.find((b) =>
          String(b.scope).startsWith("release:pins:"),
        )!;
        rows.managed.spending_budgets!.push({
          ...pin,
          scope: "release:pins:0x" + "3".repeat(64),
          reserved: "0",
          spent: "0",
          version: 0,
        });
      },
      /retained_state_row_unauthorized/,
    );
  } finally {
    await f.dispose();
  }
});

test("unauthorized changes to the retained state are refused", async () => {
  const f = await fixture();
  try {
    const first = await publish(f, "Pinned song", "retained-pinned-0002");
    assert.equal((await f.drive(first)).phase, "published");
    const pinned = await capture(f),
      capturedAt = Date.now(),
      baseline = derive(pinned);
    const second = await publish(f, "Growth song", "retained-growth-0002");
    assert.equal((await f.drive(second)).phase, "published");
    const live = await capture(f);
    assert.doesNotThrow(() => check(f.grant, live, baseline, capturedAt));
    const keyOf = (side: Side, table: string, row: Record<string, unknown>) =>
      JSON.stringify(retainedStateRules[side][table]!.key.map((c) => row[c]));
    const pinnedKeys = (side: Side, table: string) =>
      new Set(pinned[side][table]!.map((r) => keyOf(side, table, r)));
    const pinnedRows = (rows: State, side: Side, table: string) =>
      rows[side][table]!.filter((r) =>
        pinnedKeys(side, table).has(keyOf(side, table, r)),
      );
    const growthRows = (rows: State, side: Side, table: string) =>
      rows[side][table]!.filter(
        (r) => !pinnedKeys(side, table).has(keyOf(side, table, r)),
      );
    const refused = (
      name: string,
      mutate: (rows: State) => void,
      code: RegExp,
      {
        now,
        from = baseline,
        at = capturedAt,
      }: { now?: number; from?: Baseline; at?: number } = {},
    ) => {
      const rows = structuredClone(live);
      mutate(rows);
      assert.throws(
        () => check(f.grant, rows, from, at, now),
        code,
        name,
      );
    };

    refused(
      "edited immutable column",
      (rows) => {
        pinnedRows(rows, "application", "media_submissions")[0]!.metadata_json =
          '{"title":"changed"}';
      },
      /retained_state_immutable_changed/,
    );
    refused(
      "deleted pinned row",
      (rows) => {
        const [job] = pinnedRows(rows, "application", "publication_jobs");
        rows.application.publication_jobs =
          rows.application.publication_jobs!.filter((r) => r !== job);
      },
      /retained_state_pinned_row_missing/,
    );
    refused(
      "terminal job reverted",
      (rows) => {
        pinnedRows(rows, "application", "publication_jobs")[0]!.phase =
          "publication";
      },
      /retained_state_transition_invalid/,
    );
    refused(
      "evidence of a terminal row changed",
      (rows) => {
        pinnedRows(rows, "application", "publication_jobs")[0]!.progress_json =
          "{}";
      },
      /retained_state_terminal_changed/,
    );
    refused(
      "set-once column rewritten",
      (rows) => {
        pinnedRows(rows, "application", "external_operations").find(
          (o) => o.result_json != null,
        )!.result_json = '{"changed":true}';
      },
      /retained_state_set_once_changed/,
    );
    refused(
      "decreased counter",
      (rows) => {
        const job = pinnedRows(rows, "application", "publication_jobs")[0]!;
        job.revision = Number(job.revision) - 1;
      },
      /retained_state_counter_decreased/,
    );
    refused(
      "illegal reservation transition",
      (rows) => {
        pinnedRows(rows, "managed", "spending_reservations").find(
          (r) => r.status === "settled",
        )!.status = "reserved";
      },
      /retained_state_transition_invalid/,
    );
    refused(
      "budget over its ceiling",
      (rows) => {
        const budget = rows.managed.spending_budgets!.find(
          (b) => b.asset === "pin_bytes",
        )!;
        const reservation = growthRows(
          rows,
          "managed",
          "spending_reservations",
        ).find(
          (r) =>
            r.scope === budget.scope &&
            r.period === budget.period &&
            r.asset === budget.asset,
        )!;
        const over = BigInt(String(budget.ceiling)) + 1n,
          rest =
            BigInt(String(budget.spent)) - BigInt(String(reservation.actual));
        reservation.amount = (over - rest).toString();
        reservation.actual = (over - rest).toString();
        budget.spent = over.toString();
      },
      /retained_state_budget_invalid/,
    );
    refused(
      "budget not equal to its reservations",
      (rows) => {
        const budget = growthRows(rows, "managed", "spending_budgets")[0] ??
          rows.managed.spending_budgets!.find((b) => b.asset === "pin_adds")!;
        budget.reserved = (BigInt(String(budget.reserved)) + 1n).toString();
      },
      /retained_state_budget_invalid/,
    );
    refused(
      "new owner budget at another ceiling",
      (rows) => {
        rows.managed.spending_budgets!.find(
          (b) => b.asset === "songs",
        )!.ceiling = "99";
      },
      /retained_state_budget_invalid/,
      { from: derive(productionShaped(pinned)), at: 0 },
    );
    refused(
      "reservation with no operation",
      (rows) => {
        const r = growthRows(rows, "managed", "spending_reservations").find(
          (x) => String(x.scope).startsWith("moderation:"),
        )!;
        rows.managed.spending_reservations!.push({
          ...r,
          reservation_id: "0x" + "de".repeat(32),
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new row in a table that only holds history",
      (rows) => {
        rows.managed.managed_releases!.push({
          ...pinnedRows(rows, "managed", "managed_releases")[0],
          grant_hash: "0x" + "ab".repeat(32),
          request_hash: "0x" + "ab".repeat(32),
          context_json: "{}",
          admission_sha256: "0x" + "ab".repeat(32),
          created_at: Date.now(),
        });
      },
      /retained_state_row_unauthorized|retained_state_value_invalid/,
    );
    refused(
      "new submission from another wallet",
      (rows) => {
        rows.application.media_submissions!.push({
          ...growthRows(rows, "application", "media_submissions")[0],
          submission_id: "foreign-submission",
          post_id: "0x" + "9".repeat(64),
          object_key: "staging/foreign",
          idempotency_key: "foreign",
          captured_wallet: "0x" + "cd".repeat(20),
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new binding for an unknown account",
      (rows) => {
        rows.application.credential_bindings!.push({
          ...rows.application.credential_bindings![0]!,
          binding_id: "foreign-binding",
          account_id: "foreign-account",
          subject: "0x" + "ab".repeat(20),
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new admission for another community",
      (rows) => {
        rows.managed.managed_admissions!.push({
          ...growthRows(rows, "managed", "managed_admissions")[0],
          admission_id: "0x" + "8".repeat(64),
          job_id: "foreign-job",
          community_id: "0x" + "7".repeat(64),
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new admission dated before the baseline",
      (rows) => {
        rows.managed.managed_admissions!.push({
          ...growthRows(rows, "managed", "managed_admissions")[0],
          admission_id: "0x" + "6".repeat(64),
          job_id: "early-job",
          created_at: capturedAt - 1000,
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new submission dated before the baseline",
      (rows) => {
        rows.application.media_submissions!.push({
          ...growthRows(rows, "application", "media_submissions")[0],
          submission_id: "early-submission",
          post_id: "0x" + "5".repeat(64),
          object_key: "staging/early",
          idempotency_key: "early",
          created_at: capturedAt - 1000,
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "new admission dated in the future",
      (rows) => {
        rows.managed.managed_admissions!.push({
          ...growthRows(rows, "managed", "managed_admissions")[0],
          admission_id: "0x" + "4".repeat(64),
          job_id: "future-job",
          created_at: Date.now() + 3600_000,
        });
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "provider call start rewritten",
      (rows) => {
        const call = pinnedRows(rows, "managed", "moderation_provider_calls").find(
          (c) => c.started_at != null,
        )!;
        call.started_at = Number(call.started_at) + 1;
      },
      /retained_state_set_once_changed/,
    );
    refused(
      "pin byte reservation without its add reservation",
      (rows) => {
        const adds = growthRows(rows, "managed", "spending_reservations").find(
          (r) => r.asset === "pin_adds",
        )!;
        const op = String(adds.reservation_id).slice(0, -5);
        rows.managed.spending_reservations =
          rows.managed.spending_reservations!.filter((r) => r !== adds);
        const budget = rows.managed.spending_budgets!.find(
          (b) =>
            b.scope === adds.scope &&
            b.period === adds.period &&
            b.asset === adds.asset,
        )!;
        budget.spent = (
          BigInt(String(budget.spent)) - BigInt(String(adds.actual))
        ).toString();
        // Leave the byte reservation and no funded pin for that operation.
        rows.managed.funded_pins = rows.managed.funded_pins!.filter(
          (p) => p.operation_id !== op,
        );
        rows.managed.spending_reservations = rows.managed
          .spending_reservations!.filter(
            (r) => !(String(r.scope).startsWith("release:pins:") && r.reservation_id === op),
          );
        for (const b of rows.managed.spending_budgets!)
          if (String(b.scope).startsWith("release:pins:")) {
            const own = rows.managed.spending_reservations!.filter(
              (r) => r.scope === b.scope && r.period === b.period,
            );
            b.spent = own
              .reduce((n, r) => n + BigInt(String(r.actual)), 0n)
              .toString();
          }
      },
      /retained_state_row_unauthorized/,
    );
    refused(
      "unclassified column",
      (rows) => {
        growthRows(rows, "managed", "funded_pins")[0]!.extra = 1;
      },
      /retained_state_column_unclassified/,
    );
    refused(
      "deleted nonce",
      (rows) => {
        const [nonce] = pinnedRows(rows, "managed", "moderation_request_nonces");
        rows.managed.moderation_request_nonces =
          rows.managed.moderation_request_nonces!.filter((r) => r !== nonce);
      },
      /retained_state_pinned_row_missing/,
      { now: nowSeconds() + 10 ** 9 },
    );
    // A pinned input capability may disappear only after it expires.
    const expired = structuredClone(live);
    const [capability] = pinnedRows(
      expired,
      "application",
      "moderation_input_capabilities",
    );
    expired.application.moderation_input_capabilities =
      expired.application.moderation_input_capabilities!.filter(
        (r) => r !== capability,
      );
    assert.throws(
      () => check(f.grant, expired, baseline, capturedAt),
      /retained_state_pinned_row_missing/,
    );
    assert.doesNotThrow(() =>
      check(
        f.grant,
        expired,
        baseline,
        capturedAt,
        Number(capability!.expires_at),
      ),
    );
    // A pin whose byte reservation was refused, or that stopped before its
    // row was written, leaves owner and per-release reservations without a
    // funded pin. That stays acceptable.
    const orphan = structuredClone(live);
    const keptPins = new Set(
      pinnedRows(orphan, "managed", "funded_pins").map((p) => p.operation_id),
    );
    const dropped = growthRows(orphan, "managed", "funded_pins").map(
      (p) => p.operation_id,
    );
    assert.ok(dropped.length > 0);
    orphan.managed.funded_pins = orphan.managed.funded_pins!.filter((p) =>
      keptPins.has(p.operation_id),
    );
    const bytes = orphan.managed.spending_reservations!.find(
      (r) => r.reservation_id === `${dropped[0]}:bytes`,
    )!;
    orphan.managed.spending_reservations =
      orphan.managed.spending_reservations!.filter((r) => r !== bytes);
    const byteBudget = orphan.managed.spending_budgets!.find(
      (b) =>
        b.scope === bytes.scope &&
        b.period === bytes.period &&
        b.asset === bytes.asset,
    )!;
    byteBudget.spent = (
      BigInt(String(byteBudget.spent)) - BigInt(String(bytes.actual))
    ).toString();
    assert.doesNotThrow(() => check(f.grant, orphan, baseline, capturedAt));
  } finally {
    await f.dispose();
  }
});

test("the release check binds the baseline record to its digest, the pinned state and the repair", async () => {
  const f = await fixture();
  try {
    const start = new Date(Date.now() - 1).toISOString();
    const first = await publish(f, "Bound song", "retained-bound-0001");
    assert.equal((await f.drive(first)).phase, "published");
    const live = await capture(f),
      baseline = derive(productionShaped(live));
    const published = JSON.parse(
        await readFile(
          "docs/deployments/first-song-managed-20261105.published-state.json",
          "utf8",
        ),
      ),
      repair = JSON.parse(await readFile(publishedStateRepairPath, "utf8"));
    const record = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        schema: "pirate.retained-state-baseline/1",
        capturedAt: start,
        captureSha256: "0x" + "00".repeat(32),
        predecessorStateSha256: publishedStateHash,
        repairSha256: publishedStateRepairHash,
        ...baseline,
        ...overrides,
      });
    const run = (
      text: string,
      digest: string = hashText(text),
      side: Side = "managed",
    ) =>
      assertRetainedAgainstBaseline(
        text,
        digest,
        published,
        side === "managed" ? repair : undefined,
        side,
        live[side],
        f.grant,
        nowSeconds(),
      );
    for (const side of sides) assert.doesNotThrow(() => run(record(), undefined, side));
    assert.throws(
      () => run(record(), "0x" + "11".repeat(32)),
      /retained_state_baseline_changed/,
    );
    assert.throws(
      () => run(record({ repairSha256: "0x" + "22".repeat(32) })),
      /retained_state_baseline_unbound/,
    );
    assert.throws(
      () => run(record({ managed: { funded_pins: [] } })),
      /retained_state_baseline_invalid/,
    );
    // A later capture time makes the song's rows predate the baseline.
    assert.throws(
      () => run(record({ capturedAt: new Date(Date.now() + 60000).toISOString() })),
      /retained_state_row_unauthorized/,
    );
  } finally {
    await f.dispose();
  }
});

test("the baseline builder refuses a capture not bound to, or not equal to, the pinned state", async () => {
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  for (const capture of [
    { schema: "pirate.retained-state-capture/1", capturedAt: "x" },
    {
      schema: "pirate.retained-state-capture/2",
      capturedAt: "2026-11-09T16:46:02.629Z",
    },
  ])
    assert.throws(
      () => retainedBaselineFromCapture(bytes(capture), {}, {}),
      /retained_state_capture_unbound/,
    );
  const published = JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.published-state.json",
        "utf8",
      ),
    ),
    repair = JSON.parse(await readFile(publishedStateRepairPath, "utf8"));
  const empty = (side: Side) =>
    Object.fromEntries(
      Object.keys(retainedStateRules[side]).map((t) => [t, []]),
    );
  // Bound by its hashes, but its rows are not the pinned rows.
  assert.throws(
    () =>
      retainedBaselineFromCapture(
        bytes({
          schema: "pirate.retained-state-capture/1",
          capturedAt: "2026-11-09T16:46:02.629Z",
          expectedSha256: publishedStateHash,
          repairSha256: publishedStateRepairHash,
          application: { summary: {}, rows: empty("application") },
          managed: { summary: {}, rows: empty("managed") },
        }),
        published,
        repair,
      ),
    /published_state_changed/,
  );
});

test("a baseline is derived only from valid rows", async () => {
  const f = await fixture();
  try {
    const first = await publish(f, "Valid song", "retained-valid-0001");
    assert.equal((await f.drive(first)).phase, "published");
    const live = await capture(f);
    assert.doesNotThrow(() => derive(live));
    const badPhase = structuredClone(live);
    badPhase.application.publication_jobs![0]!.phase = "bogus";
    assert.throws(() => derive(badPhase), /retained_state_value_invalid/);
    const unbalanced = structuredClone(live);
    const budget = unbalanced.managed.spending_budgets![0]!;
    budget.spent = (BigInt(String(budget.spent)) + 1n).toString();
    assert.throws(() => derive(unbalanced), /retained_state_budget_invalid/);
  } finally {
    await f.dispose();
  }
});

test("the committed baseline is the pinned one, bound to the pinned state and the November 9 capture", async () => {
  const text = await readFile(retainedStateBaseline.path, "utf8");
  assert.equal(hashText(text), retainedStateBaseline.sha256);
  const record = readRetainedBaseline(JSON.parse(text));
  assert.equal(record.predecessorStateSha256, publishedStateHash);
  assert.equal(record.repairSha256, publishedStateRepairHash);
  assert.equal(
    record.captureSha256,
    "0xefac3b8c81421dab26df6333e9e523443ee9d9e4275859e7540e4e53498f14b3",
  );
  assert.equal(record.capturedAt, "2026-11-09T16:46:02.629Z");
  for (const side of sides)
    for (const rows of Object.values(record[side]))
      for (const row of rows)
        for (const value of Object.values(row.values))
          assert.ok(
            value === null ||
              typeof value === "number" ||
              (typeof value === "string" && value.length <= 120),
          );
});
