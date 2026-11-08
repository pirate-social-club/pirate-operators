// Owner authorization signatures and bounded owner budget windows for the
// unregistered owner policy. Real signatures, real D1 budget tables.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "../packages/community/budgets.ts";
import {
  ownerBudgetCeiling,
  ownerBudgetKey,
  ownerGrantDigest,
  claimOwnerWindow,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { configuration } from "./fixtures/release-admission.ts";

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
    await migrate(community, [
      "apps/community-wizard/infra/migrations/0001_setup.sql",
      "apps/community-wizard/infra/migrations/0002_first_song.sql",
      "apps/community-wizard/infra/migrations/0009_owner_budget_windows.sql",
    ]);
    await migrate(managed, [
      "apps/managed-moderation/migrations/0001_managed.sql",
      "apps/managed-moderation/migrations/0004_owner_budget_windows.sql",
    ]);
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
    // Raising the limit by replacement inside the window is refused.
    const raised = validateOwnerGrant(
      grant({ limits: { ...grant().limits, songs: 10 } }),
    );
    await assert.rejects(
      configureBudget(
        db,
        await claimOwnerWindow(db, raised, 1600),
        ownerBudgetCeiling(raised, "songs"),
      ),
      /budget_profile_changed/,
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
    // Community service: its post-fee bucket is not configured yet, so the
    // post reservation fails after the managed side already reserved.
    await claimOwnerWindow(f.community, g, 1500);
    const fee = ownerBudgetKey(g, "post_fee_wei");
    await assert.rejects(
      reserveBudget(f.community, `${job}:post:fee`, request, [fee], "1000"),
      /budget_not_configured/,
    );
    // Recovery: configure, then retry the whole step with the same identities.
    await configureBudget(
      f.community,
      fee,
      ownerBudgetCeiling(g, "post_fee_wei"),
    );
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
