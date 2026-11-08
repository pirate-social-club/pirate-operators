// Owner authorization signatures and bounded owner budget windows for the
// unregistered owner policy. Real signatures, real D1 budget tables.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
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
  requireOwnerWindow,
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

test("replacing a grant cannot reset consumption inside its window or open an overlapping one", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of ["0001_setup.sql", "0002_first_song.sql"]) {
      const sql = await readFile(
        new URL(
          `../apps/community-wizard/infra/migrations/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const first = validateOwnerGrant(grant());
    const key = await requireOwnerWindow(db, first, 1500);
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
    const again = await requireOwnerWindow(db, replaced, 1600);
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
        await requireOwnerWindow(db, raised, 1600),
        ownerBudgetCeiling(raised, "songs"),
      ),
      /budget_profile_changed/,
    );
    // An overlapping window cannot be opened to reset consumption.
    await assert.rejects(
      requireOwnerWindow(
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
      (await requireOwnerWindow(db, next, 2500)).period,
      key.period,
    );
    await assert.rejects(
      requireOwnerWindow(db, next, 3000),
      /owner_grant_outside_window/,
    );
  } finally {
    await runtime.dispose();
  }
});
