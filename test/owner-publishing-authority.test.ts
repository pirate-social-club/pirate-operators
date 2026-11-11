// Owner authorization signatures and bounded owner budget windows for the
// unregistered owner policy. Real signatures, real D1 budget tables.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import {
  OWNER_POLICY_HASH,
  OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";
import {
  requireAuthorizedOwner,
  validateOwnerAuthorization,
} from "../packages/community/owner-authorization.ts";
import {
  configureBudget,
  reserveBudget,
  settleBudget,
} from "../packages/community/budgets.ts";
import {
  advanceJob,
  jobSteps,
  leaseJob,
  loadJob,
  resumeUncertainJob,
} from "../packages/community/publication-store.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../packages/community/manifest-core.ts";
import {
  ownerBudgetCeiling,
  ownerBudgetKey,
  ownerGrantDigest,
  reserveOwnerBudget,
  settleOwnerBudget,
  claimOwnerWindow,
  ownerWindowCondition,
  requireOwnerGrantTime,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { configuration } from "./fixtures/release-admission.ts";
import { journaledProviderCall } from "../packages/moderation/provider-journal.ts";
import {
  communityMigrations,
  managedMigrations,
} from "../harness/package-migrations.ts";

const controller = privateKeyToAccount(`0x${"21".repeat(32)}`),
  stranger = privateKeyToAccount(`0x${"22".repeat(32)}`),
  owner = "0x" + "ab".repeat(20),
  policy = {
    version: UNREGISTERED_OWNER_POLICY_VERSION,
    sha256: UNREGISTERED_OWNER_POLICY_HASH,
  };
const config = validateConfig({
  ...configuration,
  controller: controller.address.toLowerCase(),
  policies: { ...configuration.policies, admission: policy },
});
const authorization = (overrides: Record<string, unknown> = {}) => ({
  schema: "pirate.owner-publishing-authorization/1",
  communityId: config.communityId,
  ownerWallet: owner,
  policy,
  validFrom: 1000,
  expiresAt: 2000,
  ...overrides,
});
const sign = async (
  a: Record<string, unknown>,
  signer: typeof controller = controller,
) => ({
  authorization: a,
  signature: await signer.signMessage({
    message: { raw: hashJson(a) as `0x${string}` },
  }),
});

test("only the controller can authorize the owner wallet, for this policy and window", async () => {
  const signed = await sign(authorization());
  assert.equal(
    (await validateOwnerAuthorization(signed, config)).authorization
      .ownerWallet,
    owner,
  );
  assert.equal(
    (
      await requireAuthorizedOwner(
        signed,
        config,
        owner.toUpperCase().replace("0X", "0x"),
        1500,
      )
    ).ownerWallet,
    owner,
  );
  // The controller and publisher are not the owner.
  await assert.rejects(
    requireAuthorizedOwner(signed, config, config.controller, 1500),
    /owner_publication_only/,
  );
  await assert.rejects(
    requireAuthorizedOwner(signed, config, config.publisher, 1500),
    /owner_publication_only/,
  );
  await assert.rejects(
    requireAuthorizedOwner(signed, config, owner, 2000),
    /owner_authorization_outside_window/,
  );
  await assert.rejects(
    requireAuthorizedOwner(signed, config, owner, 999),
    /owner_authorization_outside_window/,
  );
  await assert.rejects(
    validateOwnerAuthorization(await sign(authorization(), stranger), config),
    /untrusted_owner_authorization_signer/,
  );
  await assert.rejects(
    validateOwnerAuthorization(
      {
        ...signed,
        authorization: {
          ...signed.authorization,
          ownerWallet: "0x" + "cd".repeat(20),
        },
      },
      config,
    ),
    /untrusted_owner_authorization_signer/,
  );
  await assert.rejects(
    validateOwnerAuthorization(
      await sign(
        authorization({
          policy: { version: OWNER_POLICY_VERSION, sha256: OWNER_POLICY_HASH },
        }),
      ),
      config,
    ),
    /owner_authorization_scope_mismatch/,
  );
  await assert.rejects(
    validateOwnerAuthorization(
      await sign(authorization({ recipient: owner })),
      config,
    ),
    /invalid_fields/,
  );
});

function grant(overrides: Partial<OwnerBudgetGrant> = {}): OwnerBudgetGrant {
  const g = {
    schema: "pirate.owner-publishing-grant/1" as const,
    sha256: "0x" + "00".repeat(32),
    communityId: config.communityId,
    communityOrigin: config.app.origin,
    ownerWallet: owner,
    policy,
    destination: {
      chainId: config.chainId,
      postsContract: config.postsContract,
      publisher: config.publisher,
    },
    validFrom: 1000,
    expiresAt: 2000,
    limits: {
      songs: 3,
      pinAdds: 15,
      pinBytes: String(200 * 1024 * 1024),
      recognitionRequests: 12,
      postFeeWei: "30000000000000",
    },
    ...overrides,
  };
  return { ...g, sha256: ownerGrantDigest(g) };
}

test("owner budget grants bind the unregistered policy and cap every paid resource", () => {
  const g = validateOwnerGrant(grant());
  assert.equal(g.limits.songs, 3);
  assert.equal(ownerBudgetCeiling(g, "pin_bytes"), String(200 * 1024 * 1024));
  assert.throws(
    () => validateOwnerGrant({ ...grant(), sha256: "0x" + "11".repeat(32) }),
    /owner_grant_binding_invalid/,
  );
  assert.throws(
    () =>
      validateOwnerGrant(
        grant({
          policy: { version: OWNER_POLICY_VERSION, sha256: OWNER_POLICY_HASH },
        }),
      ),
    /owner_grant_binding_invalid/,
  );
  assert.throws(
    () => validateOwnerGrant({ ...grant(), registration: {} }),
    /invalid_fields/,
  );
  assert.throws(
    () =>
      validateOwnerGrant(
        grant({
          limits: { ...grant().limits, postFeeWei: "1000000000000000000" },
        }),
      ),
    /owner_grant_exceeds_test_bounds/,
  );
  assert.throws(
    () =>
      validateOwnerGrant(
        grant({ destination: { ...grant().destination, chainId: 1 } }),
      ),
    /unsupported_publication_chain/,
  );
  // Replacement grants inside a window share buckets; the grant hash is not the key.
  const replaced = validateOwnerGrant(
    grant({ communityOrigin: "https://replacement.example" }),
  );
  assert.notEqual(replaced.sha256, g.sha256);
  assert.deepEqual(
    ownerBudgetKey(g, "songs"),
    ownerBudgetKey(replaced, "songs"),
  );
  assert.equal(ownerBudgetKey(g, "songs").scope.includes(g.sha256), false);
});

// Both paying services keep their own D1 database. The worker runs concurrent
// claims inside workerd so D1, not the host adapter, decides the race.
const claimWorker = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      import { claimOwnerWindow } from './packages/release/owner-grant.ts';
      export default { async fetch(request, env) {
        const { database, grants, now } = await request.json();
        const results = await Promise.allSettled(
          grants.map((g) => claimOwnerWindow(env[database], g, now)));
        return Response.json(results.map((r) => r.status === 'fulfilled'
          ? { ok: true, period: r.value.period }
          : { ok: false, code: r.reason.code ?? String(r.reason) }));
      }};
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["node:*"],
});
async function migrate(db: D1Database, files: string[]) {
  for (const file of files) {
    const sql = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement)),
    );
  }
}
const COMMUNITY = "apps/community-wizard/infra/migrations",
  MANAGED = "apps/managed-moderation/migrations";
/** The complete ordered chain in a migrations directory, optionally stopping before a file. */
async function chain(directory: string, before?: string) {
  const names = (await readdir(new URL(`../${directory}`, import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  return names
    .filter((name) => !before || name < before)
    .map((name) => `${directory}/${name}`);
}
async function ownerDatabases() {
  const runtime = new Miniflare({
    modules: true,
    script: claimWorker.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB", "MANAGED"],
  });
  try {
    const community = await runtime.getD1Database("DB"),
      managed = await runtime.getD1Database("MANAGED");
    // Use the same owner/V4 migration profile as the retained deployment.
    // Private media and Dance are separate opt-in profiles with their own tests.
    const communityNames = (await chain(COMMUNITY)).map(
      (path) => path.split("/").at(-1)!,
    );
    await migrate(
      community,
      communityMigrations(communityNames, {
        rewards: true,
        ownerPublishing: true,
        v4: true,
      }).map((name) => `${COMMUNITY}/${name}`),
    );
    await migrate(
      managed,
      managedMigrations(true).map((name) => `${MANAGED}/${name}`),
    );
    return {
      community,
      managed,
      async concurrentClaims(
        database: "DB" | "MANAGED",
        grants: OwnerBudgetGrant[],
        now: number,
      ) {
        const response = await runtime.dispatchFetch(
          "https://fixture.example/claims",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ database, grants, now }),
          },
        );
        assert.equal(response.status, 200);
        return (await response.json()) as (
          | { ok: true; period: string }
          | { ok: false; code: string }
        )[];
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("replacing a grant cannot reset consumption inside its window or open an overlapping one", async () => {
  const f = await ownerDatabases();
  try {
    const db = f.community;
    const first = validateOwnerGrant(grant());
    const key = await claimOwnerWindow(db, first, 1500);
    await configureBudget(db, key, ownerBudgetCeiling(first, "songs"));
    for (const job of ["job-1", "job-2", "job-3"])
      await reserveBudget(db, `song:${job}`, hashJson({ job }), [key], "1");
    // A retry of the same job does not charge again.
    await reserveBudget(
      db,
      "song:job-1",
      hashJson({ job: "job-1" }),
      [key],
      "1",
    );
    await assert.rejects(
      reserveBudget(db, "song:job-4", hashJson({ job: "job-4" }), [key], "1"),
      /funding_cap_exhausted/,
    );
    // Same window, replacement grant: same bucket, still exhausted.
    const replaced = validateOwnerGrant(
      grant({ communityOrigin: "https://replacement.example" }),
    );
    assert.notEqual(replaced.sha256, first.sha256);
    const again = await claimOwnerWindow(db, replaced, 1600);
    assert.deepEqual(again, key);
    await assert.rejects(
      reserveBudget(db, "song:job-4", hashJson({ job: "job-4" }), [again], "1"),
      /funding_cap_exhausted/,
    );
    // Raising the limit by replacement inside the window is refused at the
    // claim, before any bucket is touched.
    const raised = validateOwnerGrant(
      grant({ limits: { ...grant().limits, songs: 10 } }),
    );
    await assert.rejects(
      claimOwnerWindow(db, raised, 1600),
      /owner_budget_limits_changed/,
    );
    // An overlapping window cannot be opened to reset consumption.
    await assert.rejects(
      claimOwnerWindow(
        db,
        validateOwnerGrant(grant({ validFrom: 1500, expiresAt: 3000 })),
        1700,
      ),
      /owner_budget_window_overlap/,
    );
    // The next adjacent window is a new, separate period.
    const next = validateOwnerGrant(
      grant({ validFrom: 2000, expiresAt: 3000 }),
    );
    assert.notEqual(
      (await claimOwnerWindow(db, next, 2500)).period,
      key.period,
    );
    await assert.rejects(
      claimOwnerWindow(db, next, 3000),
      /owner_grant_outside_window/,
    );
  } finally {
    await f.dispose();
  }
});

test("concurrent overlapping windows: exactly one wins in each service database", async () => {
  const f = await ownerDatabases();
  try {
    const a = validateOwnerGrant(grant({ validFrom: 1000, expiresAt: 2000 })),
      b = validateOwnerGrant(grant({ validFrom: 1500, expiresAt: 2500 }));
    for (const database of ["DB", "MANAGED"] as const) {
      const results = await f.concurrentClaims(
        database,
        [a, b, a, b, a, b, a, b],
        1700,
      );
      const winners = new Set(results.flatMap((r) => (r.ok ? [r.period] : [])));
      assert.equal(winners.size, 1, database);
      for (const r of results)
        if (!r.ok) assert.equal(r.code, "owner_budget_window_overlap");
      const db = database === "DB" ? f.community : f.managed;
      const rows = await db
        .prepare("SELECT valid_from,expires_at FROM owner_budget_windows")
        .all<{ valid_from: number; expires_at: number }>();
      assert.equal(rows.results.length, 1);
      assert.equal(
        `${rows.results[0]!.valid_from}-${rows.results[0]!.expires_at}`,
        [...winners][0],
      );
    }
    // Identical concurrent claims of one window all succeed.
    const c = validateOwnerGrant(grant({ validFrom: 5000, expiresAt: 6000 }));
    const same = await f.concurrentClaims("DB", [c, c, c, c], 5500);
    assert.ok(same.every((r) => r.ok));
    // Once advanced, the superseded window can no longer open spending.
    await assert.rejects(
      claimOwnerWindow(f.community, a, 1700),
      /owner_budget_window_superseded|owner_budget_window_overlap/,
    );
  } finally {
    await f.dispose();
  }
});

test("a song reserved in the managed service survives a failed community reservation and retries without double charge", async () => {
  const f = await ownerDatabases();
  try {
    const g = validateOwnerGrant(grant());
    const job = "publication:fixture-job",
      request = hashJson({ job, grant: g.sha256 });
    // Managed service: window, song and pin reservations succeed.
    const managedSongs = await claimOwnerWindow(f.managed, g, 1500);
    const managedPins = ownerBudgetKey(g, "pin_adds");
    await configureBudget(
      f.managed,
      managedSongs,
      ownerBudgetCeiling(g, "songs"),
    );
    await configureBudget(
      f.managed,
      managedPins,
      ownerBudgetCeiling(g, "pin_adds"),
    );
    await reserveBudget(f.managed, `${job}:song`, request, [managedSongs], "1");
    await reserveBudget(
      f.managed,
      `${job}:pin:audio`,
      request,
      [managedPins],
      "1",
    );
    // Community service: its window is not claimed yet, so its post-fee
    // bucket does not exist and the post reservation fails after the managed
    // side already reserved.
    const fee = ownerBudgetKey(g, "post_fee_wei");
    await assert.rejects(
      reserveBudget(f.community, `${job}:post:fee`, request, [fee], "1000"),
      /budget_not_configured/,
    );
    // Recovery: claiming the window configures every bucket; then retry the
    // whole step with the same identities.
    await claimOwnerWindow(f.community, g, 1500);
    await reserveBudget(f.managed, `${job}:song`, request, [managedSongs], "1");
    await reserveBudget(
      f.managed,
      `${job}:pin:audio`,
      request,
      [managedPins],
      "1",
    );
    await reserveBudget(f.community, `${job}:post:fee`, request, [fee], "1000");
    const reserved = async (db: D1Database, asset: string) =>
      (
        await db
          .prepare(
            "SELECT reserved FROM spending_budgets WHERE scope=? AND asset=?",
          )
          .bind(managedSongs.scope, asset)
          .first<{ reserved: string }>()
      )?.reserved;
    assert.equal(await reserved(f.managed, "songs"), "1");
    assert.equal(await reserved(f.managed, "pin_adds"), "1");
    assert.equal(await reserved(f.community, "post_fee_wei"), "1000");
    // A conflicting retry under a different request is refused, not charged.
    await assert.rejects(
      reserveBudget(
        f.managed,
        `${job}:song`,
        hashJson({ other: true }),
        [managedSongs],
        "1",
      ),
      /reservation_conflict/,
    );
    assert.equal(await reserved(f.managed, "songs"), "1");
  } finally {
    await f.dispose();
  }
});

test("a request paused after claiming a window cannot spend once the window advances, but its existing reservation stays settleable", async () => {
  const f = await ownerDatabases();
  try {
    const a = validateOwnerGrant(grant({ validFrom: 1000, expiresAt: 2000 })),
      b = validateOwnerGrant(grant({ validFrom: 2000, expiresAt: 3000 }));
    await claimOwnerWindow(f.managed, a, 1500);
    // Spent before the pause: one song reserved under window A.
    await reserveOwnerBudget(
      f.managed,
      a,
      "songs",
      "song:job-1",
      hashJson({ job: 1 }),
      "1",
      1500,
    );
    // The request pauses holding window A and a clock reading of 1999.
    // Meanwhile the window advances to B.
    await claimOwnerWindow(f.managed, b, 2000);
    // Resuming: the earlier claim and the stale clock do not authorize new spending.
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        a,
        "songs",
        "song:job-2",
        hashJson({ job: 2 }),
        "1",
        1999,
      ),
      /owner_budget_window_superseded/,
    );
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        a,
        "pin_adds",
        "pin:job-1:audio",
        hashJson({ job: 1 }),
        "1",
        1999,
      ),
      /owner_budget_window_superseded/,
    );
    // A request that passed its claim before the advance is still refused by
    // the condition committed with the reservation itself.
    await assert.rejects(
      reserveBudget(
        f.managed,
        "song:job-2",
        hashJson({ job: 2 }),
        [ownerBudgetKey(a, "songs")],
        "1",
        ownerWindowCondition(a),
      ),
      /owner_budget_window_not_current/,
    );
    // Replaying the reservation that already exists is not new spending.
    await reserveOwnerBudget(
      f.managed,
      a,
      "songs",
      "song:job-1",
      hashJson({ job: 1 }),
      "1",
      1999,
    );
    // Settlement of the existing reservation still works after advancement.
    await settleBudget(
      f.managed,
      "song:job-1",
      [ownerBudgetKey(a, "songs")],
      "1",
    );
    const row = await f.managed
      .prepare(
        "SELECT reserved,spent FROM spending_budgets WHERE scope=? AND period=? AND asset='songs'",
      )
      .bind(ownerBudgetKey(a, "songs").scope, ownerBudgetKey(a, "songs").period)
      .first<{ reserved: string; spent: string }>();
    assert.deepEqual({ ...row }, { reserved: "0", spent: "1" });
    // Window B spends from its own bucket.
    await reserveOwnerBudget(
      f.managed,
      b,
      "songs",
      "song:job-2",
      hashJson({ job: 2 }),
      "1",
      2001,
    );
    // An expired grant refuses new spending by time alone.
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        b,
        "songs",
        "song:job-3",
        hashJson({ job: 3 }),
        "1",
        3000,
      ),
      /owner_grant_outside_window/,
    );
  } finally {
    await f.dispose();
  }
});

test("each job keeps the step sequence of its captured policy through advancement, leasing and recovery", async () => {
  const f = await ownerDatabases();
  try {
    const db = f.community,
      now = 1_800_000_000_000;
    await db
      .prepare("INSERT INTO community_accounts VALUES('account-1',?,?)")
      .bind("0x" + "aa".repeat(32), now)
      .run();
    const job = async (
      id: string,
      policy: { version: string; sha256: string },
      phase: string,
      progress = "{}",
    ) => {
      await db
        .prepare(
          `INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
          VALUES(?,'account-1',?,?,?,?,'{}',?,'null',?,1,?,'sealed',?)`,
        )
        .bind(
          id,
          "0x" + "aa".repeat(32),
          hashJson({ post: id }),
          id,
          hashJson({ id }),
          owner,
          hashJson({ audio: id }),
          `staging/${id}`,
          now,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,progress_json,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          `publication:${id}`,
          id,
          hashJson({ id }),
          JSON.stringify({ policy }),
          phase,
          progress,
          now,
          now,
          now,
        )
        .run();
      return `publication:${id}`;
    };
    const unregisteredJob = await job("s-new", policy, "pin_lyrics"),
      registeredJob = await job(
        "s-old",
        { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
        "pin_lyrics",
      );
    assert.equal(
      jobSteps(await loadJob(db, unregisteredJob)).includes("registration"),
      false,
    );
    assert.equal(
      jobSteps(await loadJob(db, registeredJob)).includes("registration"),
      true,
    );
    for (const [id, expected] of [
      [unregisteredJob, "pin_manifest"],
      [registeredJob, "registration"],
    ] as const) {
      const leased = await leaseJob(db, id, now);
      assert.ok(leased);
      await advanceJob(db, leased, "pin_lyrics", { fixture: true }, now);
      assert.equal((await loadJob(db, id)).phase, expected);
    }
    // A new-policy job cannot be leased, advanced or resumed into registration.
    const stray = await job("s-stray", policy, "registration");
    const leaseFields = () =>
      db
        .prepare(
          "SELECT lease_token,lease_until,attempts,updated_at,phase,revision FROM publication_jobs WHERE job_id=?",
        )
        .bind(stray)
        .first();
    const untouched = await leaseFields();
    await assert.rejects(
      leaseJob(db, stray, now + 1),
      /step_outside_job_sequence/,
    );
    // Rejection happens before the lease update: nothing about the row changed.
    assert.deepEqual(await leaseFields(), untouched);
    const uncertain = await job(
      "s-uncertain",
      policy,
      "uncertain",
      JSON.stringify({ resumePhase: "registration" }),
    );
    await assert.rejects(
      resumeUncertainJob(db, uncertain, "account-1", now),
      /job_not_reconcilable/,
    );
    const resumable = await job(
      "s-resumable",
      policy,
      "uncertain",
      JSON.stringify({ resumePhase: "pin_manifest" }),
    );
    await resumeUncertainJob(db, resumable, "account-1", now);
    assert.equal((await loadJob(db, resumable)).phase, "pin_manifest");
    // An authority without any policy field keeps the full sequence and stays
    // leasable at registration (SQL NULL must not block it).
    await db
      .prepare(
        "INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at) VALUES('s-legacy','account-1',?,?,'s-legacy',?,'{}',?,'null',?,1,'staging/s-legacy','sealed',?)",
      )
      .bind(
        "0x" + "aa".repeat(32),
        hashJson({ post: "s-legacy" }),
        hashJson({ id: "s-legacy" }),
        owner,
        hashJson({ audio: "s-legacy" }),
        now,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,progress_json,due_at,created_at,updated_at) VALUES('publication:s-legacy','s-legacy',?,'{}','registration','{}',?,?,?)",
      )
      .bind(hashJson({ id: "s-legacy" }), now, now, now)
      .run();
    assert.ok(await leaseJob(db, "publication:s-legacy", now));
    // The old job still reaches registration even if the community now names the new policy:
    // its sequence comes only from its own captured authority.
    assert.equal((await loadJob(db, registeredJob)).phase, "registration");
  } finally {
    await f.dispose();
  }
});

test("community schema upgrades the complete 0001-0011 chain to 0012 and keeps Study and rewards data", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB"),
      predecessor = await chain(COMMUNITY, "0012_");
    assert.deepEqual(
      predecessor.map((p) => p.split("/").at(-1)!.slice(0, 4)),
      [
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
      ],
    );
    assert.ok(predecessor.at(-1)!.endsWith("0011_manual_rewards.sql"));
    await migrate(db, predecessor);
    await db.batch([
      db
        .prepare("INSERT INTO community_accounts VALUES('learner',?,1)")
        .bind("0x" + "bb".repeat(32)),
      db.prepare(
        "INSERT INTO study_lessons(lesson_id,account_id,community_id,request_id,song_json,state_json,started_at,history_cleanup_attempts) VALUES('lesson-1','learner','community','request-1','{}','{\"step\":3}',5,1)",
      ),
      db.prepare(
        "INSERT INTO reward_programs VALUES('program-1','0x' || hex(randomblob(32)),2)",
      ),
      db.prepare(
        "INSERT INTO reward_participants VALUES('program-1','learner','0x" +
          "cc".repeat(20) +
          "',7)",
      ),
    ]);
    const snapshot = async () =>
      JSON.stringify(
        await db
          .batch([
            db.prepare("SELECT * FROM study_lessons"),
            db.prepare("SELECT * FROM reward_programs"),
            db.prepare("SELECT * FROM reward_participants"),
          ])
          .then((r) => r.map((x) => x.results)),
      );
    const versions = async () =>
      (
        await db
          .prepare("SELECT version FROM setup_schema ORDER BY version")
          .all<{ version: number }>()
      ).results.map((v) => v.version);
    const before = await snapshot(),
      ledger = await versions();
    // The applied ledger ends at rewards 11 (0003 and 0004 never wrote versions).
    assert.equal(ledger.at(-1), 11);
    await migrate(db, [`${COMMUNITY}/0012_owner_budget_windows.sql`]);
    assert.equal(await snapshot(), before);
    assert.deepEqual(await versions(), [...ledger, 12]);
    await db
      .prepare("INSERT INTO owner_budget_windows VALUES('scope',1,2,'0x')")
      .run();
    await assert.rejects(
      db
        .prepare("INSERT INTO owner_budget_windows VALUES('bad',2,2,'0x')")
        .run(),
      /CHECK constraint failed/,
    );
    // Applying 0012 again is refused rather than silently re-versioned.
    await assert.rejects(
      migrate(db, [`${COMMUNITY}/0012_owner_budget_windows.sql`]),
      /already exists|UNIQUE constraint failed/,
    );
  } finally {
    await runtime.dispose();
  }
});

test("managed schema upgrades 0001-0003 to 0004 and keeps existing budgets and releases", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB"),
      predecessor = await chain(MANAGED, "0004_");
    assert.deepEqual(
      predecessor.map((p) => p.split("/").at(-1)),
      [
        "0001_managed.sql",
        "0002_release_operations.sql",
        "0003_owner_curated.sql",
      ],
    );
    await migrate(db, predecessor);
    await configureBudget(
      db,
      {
        scope: "release:grant:existing",
        period: "first-song-20261105-v1",
        asset: "root_releases",
      },
      "1",
    );
    await reserveBudget(
      db,
      "existing-release",
      hashJson({ existing: true }),
      [
        {
          scope: "release:grant:existing",
          period: "first-song-20261105-v1",
          asset: "root_releases",
        },
      ],
      "1",
    );
    const snapshot = async () =>
      JSON.stringify(
        await db
          .batch([
            db.prepare("SELECT * FROM spending_budgets"),
            db.prepare("SELECT * FROM spending_reservations"),
          ])
          .then((r) => r.map((x) => x.results)),
      );
    const before = await snapshot();
    await migrate(db, [`${MANAGED}/0004_owner_budget_windows.sql`]);
    assert.equal(await snapshot(), before);
    const g = validateOwnerGrant(grant());
    await claimOwnerWindow(db, g, 1500);
    await reserveOwnerBudget(
      db,
      g,
      "songs",
      "song:after-upgrade",
      hashJson({ after: true }),
      "1",
      1500,
    );
  } finally {
    await runtime.dispose();
  }
});

test("deployment packages add the publishing migrations only when owner publishing is selected", async () => {
  const names = (await chain(COMMUNITY)).map((p) => p.split("/").at(-1)!);
  const deployed = communityMigrations(names, {
    rewards: true,
    ownerPublishing: false,
    v4: false,
  });
  assert.equal(deployed.at(-1), "0011_manual_rewards.sql");
  assert.equal(deployed.includes("0012_owner_budget_windows.sql"), false);
  assert.deepEqual(
    communityMigrations(names, {
      rewards: true,
      ownerPublishing: true,
      v4: false,
    }),
    [...deployed, "0012_owner_budget_windows.sql"],
  );
  assert.throws(
    () =>
      communityMigrations(names, {
        rewards: false,
        ownerPublishing: true,
        v4: false,
      }),
    /owner_publishing_rewards_selection_required/,
  );
  assert.deepEqual(managedMigrations(false), [
    "0001_managed.sql",
    "0002_release_operations.sql",
    "0003_owner_curated.sql",
  ]);
  assert.deepEqual(managedMigrations(true), [
    ...managedMigrations(false),
    "0004_owner_budget_windows.sql",
  ]);
});

test("the V4 sign-in migration is opt-in and appends only after the deployed 0012", async () => {
  const names = (await chain(COMMUNITY)).map((p) => p.split("/").at(-1)!);
  assert.ok(names.includes("0013_learning_authorization.sql"));
  const publishing = communityMigrations(names, {
    rewards: true,
    ownerPublishing: true,
    v4: false,
  });
  // Unselected, no list carries it: Study-only, rewards and publishing.
  for (const selected of [
    { rewards: false, ownerPublishing: false, v4: false },
    { rewards: true, ownerPublishing: false, v4: false },
    { rewards: true, ownerPublishing: true, v4: false },
  ])
    assert.equal(
      communityMigrations(names, selected).includes(
        "0013_learning_authorization.sql",
      ),
      false,
    );
  assert.equal(publishing.at(-1), "0012_owner_budget_windows.sql");
  assert.deepEqual(
    communityMigrations(names, {
      rewards: true,
      ownerPublishing: true,
      v4: true,
    }),
    [...publishing, "0013_learning_authorization.sql"],
  );
  // V4 needs the deployed order: owner publishing, which needs rewards.
  for (const selected of [
    { rewards: true, ownerPublishing: false, v4: true },
    { rewards: false, ownerPublishing: false, v4: true },
  ])
    assert.throws(
      () => communityMigrations(names, selected),
      /learning_v4_publishing_selection_required/,
    );
  assert.throws(
    () =>
      communityMigrations(names, {
        rewards: false,
        ownerPublishing: true,
        v4: true,
      }),
    /owner_publishing_rewards_selection_required/,
  );
});

test("after real expiry an existing owner reservation replays and settles, while new spending is refused", async () => {
  const f = await ownerDatabases();
  try {
    const g = validateOwnerGrant(grant({ validFrom: 1000, expiresAt: 2000 })),
      request = hashJson({ job: "expired" });
    await claimOwnerWindow(f.managed, g, 1500);
    await reserveOwnerBudget(
      f.managed,
      g,
      "post_fee_wei",
      "post:fee:job",
      request,
      "1000",
      1500,
    );
    // The clock genuinely passes the grant's expiry; no newer window exists.
    const expired = 2500;
    await reserveOwnerBudget(
      f.managed,
      g,
      "post_fee_wei",
      "post:fee:job",
      request,
      "1000",
      expired,
    );
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        g,
        "post_fee_wei",
        "post:fee:job",
        hashJson({ other: 1 }),
        "1000",
        expired,
      ),
      /reservation_conflict/,
    );
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        g,
        "post_fee_wei",
        "post:fee:other",
        request,
        "1000",
        expired,
      ),
      /owner_grant_outside_window/,
    );
    await settleOwnerBudget(
      f.managed,
      g,
      "post_fee_wei",
      "post:fee:job",
      "640",
    );
    // Settlement is idempotent for the same receipt.
    await settleOwnerBudget(
      f.managed,
      g,
      "post_fee_wei",
      "post:fee:job",
      "640",
    );
    const key = ownerBudgetKey(g, "post_fee_wei");
    const row = await f.managed
      .prepare(
        "SELECT reserved,spent FROM spending_budgets WHERE scope=? AND period=? AND asset=?",
      )
      .bind(key.scope, key.period, key.asset)
      .first<{ reserved: string; spent: string }>();
    assert.deepEqual({ ...row }, { reserved: "0", spent: "640" });
  } finally {
    await f.dispose();
  }
});

test("the first claim binds every ceiling, so a replacement grant cannot raise one that has not been used yet", async () => {
  const f = await ownerDatabases();
  try {
    const first = validateOwnerGrant(grant());
    // Claim, then spend only a song: pin_adds has never been reserved.
    await reserveOwnerBudget(
      f.managed,
      first,
      "songs",
      "owner-song:job-1",
      hashJson({ job: 1 }),
      "1",
      1500,
    );
    const ceilings = await f.managed
      .prepare(
        "SELECT asset,ceiling FROM spending_budgets WHERE scope=? AND period=? ORDER BY asset",
      )
      .bind(
        ownerBudgetKey(first, "songs").scope,
        ownerBudgetKey(first, "songs").period,
      )
      .all<{ asset: string; ceiling: string }>();
    assert.deepEqual(
      ceilings.results.map((r) => [r.asset, r.ceiling]),
      (
        [
          "pin_adds",
          "pin_bytes",
          "post_fee_wei",
          "recognition_requests",
          "songs",
        ] as const
      ).map((a) => [a, ownerBudgetCeiling(first, a)]),
    );
    // The replacement raises pinAdds only, inside the same window.
    const raised = validateOwnerGrant(
      grant({
        limits: { ...grant().limits, pinAdds: first.limits.pinAdds + 1 },
      }),
    );
    await assert.rejects(
      reserveOwnerBudget(
        f.managed,
        raised,
        "pin_adds",
        "pin:job-1:audio:adds",
        hashJson({ pin: 1 }),
        "1",
        1600,
      ),
      /owner_budget_limits_changed/,
    );
    await assert.rejects(
      claimOwnerWindow(f.managed, raised, 1600),
      /owner_budget_limits_changed/,
    );
    // Nothing was reserved and the bound ceiling is unchanged.
    const pins = await f.managed
      .prepare(
        "SELECT ceiling,reserved FROM spending_budgets WHERE scope=? AND asset='pin_adds'",
      )
      .bind(ownerBudgetKey(first, "pin_adds").scope)
      .first<{ ceiling: string; reserved: string }>();
    assert.deepEqual(
      { ...pins },
      {
        ceiling: String(first.limits.pinAdds),
        reserved: "0",
      },
    );
    // A replacement with identical limits still spends from the same buckets.
    const same = validateOwnerGrant(
      grant({ communityOrigin: "https://replacement.example" }),
    );
    await reserveOwnerBudget(
      f.managed,
      same,
      "pin_adds",
      "pin:job-1:audio:adds",
      hashJson({ pin: 1 }),
      "1",
      1600,
    );
    // A community database claimed by the same grant binds the same limits.
    await claimOwnerWindow(f.community, first, 1500);
    await assert.rejects(
      claimOwnerWindow(f.community, raised, 1600),
      /owner_budget_limits_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("recognition rechecks the grant for each new provider reservation and dispatch, and a retained receipt reconciles after expiry", async () => {
  const f = await ownerDatabases();
  try {
    const g = validateOwnerGrant(grant({ validFrom: 1000, expiresAt: 2000 })),
      db = f.managed,
      lease = { admissionId: "admission-1", token: "lease-1" };
    await db
      .prepare(
        "INSERT INTO managed_admissions(admission_id,community_id,submission_id,job_id,request_hash,request_json,authority_json,budget_period,state,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'running',?,?,?,?)",
      )
      .bind(
        lease.admissionId,
        g.communityId,
        "submission-1",
        "job-1",
        "0x00",
        "{}",
        "{}",
        "fixture",
        lease.token,
        Date.now() + 3600000,
        Date.now(),
        Date.now(),
      )
      .run();
    const budgets = [ownerBudgetKey(g, "recognition_requests")];
    let clock = 1500,
      sends = 0,
      authorizations = 0,
      interpretFails = false;
    const response = {
      status: 200,
      contentType: "application/json",
      requestId: "acr-1",
      body: "{}",
      bodySha256: hashJson({}),
    };
    // The same per-call authorization and dispatch checks process-admission uses.
    const call = (kind: "acr_primary" | "acr_alternate") => ({
      kind,
      budgets,
      condition: ownerWindowCondition(g),
      authorize: async () => {
        authorizations++;
        requireOwnerGrantTime(g, clock);
        await claimOwnerWindow(db, g, clock);
      },
      dispatch: async () => requireOwnerGrantTime(g, clock),
      request: { kind },
      async send(received: (r: typeof response) => Promise<void>) {
        sends++;
        await received(response);
        return response;
      },
      interpret: () => {
        if (interpretFails) throw new Error("fixture interpretation failure");
        return { code: 1001 };
      },
    });
    const reservations = async () =>
      (
        await db
          .prepare(
            "SELECT reservation_id,status FROM spending_reservations WHERE asset='recognition_requests' ORDER BY reservation_id",
          )
          .all<{ reservation_id: string; status: string }>()
      ).results;
    // A new call after expiry is refused before any reservation or send, even
    // though the window was claimed while the grant was valid.
    await claimOwnerWindow(db, g, 1500);
    clock = 2001;
    await assert.rejects(
      journaledProviderCall(db, lease, call("acr_primary")),
      /owner_grant_outside_window/,
    );
    assert.equal(sends, 0);
    assert.deepEqual(await reservations(), []);
    // Expiry between reservation and dispatch: reserved, never sent.
    clock = 1999;
    const late = call("acr_primary");
    const authorize = late.authorize;
    late.authorize = async () => {
      await authorize();
      clock = 2000;
    };
    await assert.rejects(
      journaledProviderCall(db, lease, late),
      /owner_grant_outside_window/,
    );
    assert.equal(sends, 0);
    const planned = await db
      .prepare("SELECT state FROM moderation_provider_calls WHERE kind=?")
      .bind("acr_primary")
      .first<{ state: string }>();
    assert.equal(planned!.state, "planned");
    // The refused reservation is released explicitly, not held in the window.
    const released = await db
      .prepare(
        "SELECT status,actual FROM spending_reservations WHERE asset='recognition_requests' AND status='settled'",
      )
      .all<{ status: string; actual: string }>();
    assert.deepEqual(
      released.results.map((r) => ({ ...r })),
      [{ status: "settled", actual: "0" }],
    );
    const bucket = await db
      .prepare(
        "SELECT reserved,spent FROM spending_budgets WHERE scope=? AND period=? AND asset='recognition_requests'",
      )
      .bind(budgets[0]!.scope, budgets[0]!.period)
      .first<{ reserved: string; spent: string }>();
    assert.deepEqual({ ...bucket }, { reserved: "0", spent: "0" });
    // An executor that loses its admission lease during dispatch does not
    // release: another executor may now hold the call.
    clock = 1500;
    const stale = call("acr_alternate");
    stale.dispatch = async () => {
      await db
        .prepare(
          "UPDATE managed_admissions SET lease_until=0 WHERE admission_id=?",
        )
        .bind(lease.admissionId)
        .run();
      requireOwnerGrantTime(g, 2001);
    };
    await assert.rejects(
      journaledProviderCall(db, lease, stale),
      /owner_grant_outside_window/,
    );
    assert.equal(sends, 0);
    const kept = await db
      .prepare(
        "SELECT status FROM spending_reservations WHERE asset='recognition_requests' AND reservation_id=(SELECT call_id FROM moderation_provider_calls WHERE kind='acr_alternate')",
      )
      .first<{ status: string }>();
    assert.equal(kept!.status, "reserved");
    await db
      .prepare(
        "UPDATE managed_admissions SET lease_until=? WHERE admission_id=?",
      )
      .bind(Date.now() + 3600000, lease.admissionId)
      .run();
    // Even if the clock read valid again, a released call is never sent.
    clock = 1500;
    await assert.rejects(
      journaledProviderCall(db, lease, call("acr_primary")),
      /provider_call_released/,
    );
    assert.equal(sends, 0);
    // A receipt retained while the grant was valid reconciles after expiry
    // without another authorization or send.
    clock = 1500;
    interpretFails = true;
    await assert.rejects(
      journaledProviderCall(db, lease, call("acr_alternate")),
      /fixture interpretation failure/,
    );
    assert.equal(sends, 1);
    clock = 2500;
    interpretFails = false;
    const before = authorizations;
    assert.deepEqual(
      await journaledProviderCall(db, lease, call("acr_alternate")),
      { code: 1001 },
    );
    assert.equal(sends, 1);
    assert.equal(authorizations, before);
    // One released (actual 0) for the refused dispatch, one spent for the receipt.
    const settled = await db
      .prepare(
        "SELECT actual FROM spending_reservations WHERE asset='recognition_requests' AND status='settled' ORDER BY actual",
      )
      .all<{ actual: string }>();
    assert.deepEqual(
      settled.results.map((r) => r.actual),
      ["0", "1"],
    );
  } finally {
    await f.dispose();
  }
});
