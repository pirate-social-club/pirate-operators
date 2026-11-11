import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHORITY_VALIDATION_POLICY } from "../packages/community-setup/authority-validation.ts";
import { guardedPaginationFixture } from "./telegram-guarded-pagination-fixture.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";
import { accounts } from "../harness/runtime.ts";

// UNRUN. Apply the exact current241 fixture proposals first. Native SQLite/D1,
// real shared validation, V4 signature verification and signed request crypto;
// only operator transport/receipts are explicit retained test fixtures.
async function pages(f: Awaited<ReturnType<typeof guardedPaginationFixture>>) {
  const ids = [...f.ids].sort();
  const first = {
    cursor: null,
    next: "page-1",
    authorizationIds: ids.slice(0, 40),
    exhausted: false,
  };
  f.publication.appendAuthorizations(f.transitionId, first);
  f.publication.appendAuthorizations(f.transitionId, first);
  assert.throws(
    () =>
      f.publication.appendAuthorizations(f.transitionId, {
        ...first,
        authorizationIds: ids.slice(0, 1),
      }),
    /conflict/,
  );
  await f.persistPage(first);
  await assert.rejects(
    f.publication.finishAuthorityTransition(f.transitionId),
    /publication_pending/,
  );
  assert.equal(f.denials.size, 0);
  const last = {
    cursor: "page-1",
    next: null,
    authorizationIds: ids.slice(40),
    exhausted: true,
  };
  f.publication.appendAuthorizations(f.transitionId, last);
  await f.persistPage(last);
}

test("a missing fixture guard stays held; the real retained D1 guard resumes all 66 original denials through pagination and recreation", async (t) => {
  const f = await guardedPaginationFixture(t);
  await pages(f);
  const original = f.snapshot();
  const missing = managedFixture(
    f.publication.grants,
    { ...f.action.scope, enabled: true },
    f.model.ports.authority,
  );
  for (let n = 0; n < 4; n++) {
    f.advance();
    await missing.create().recover();
  }
  assert.equal(missing.denials.size, 0);
  assert.equal(f.denials.size, 0);
  assert.equal(f.snapshot().remote?.complete, false);
  assert.ok(missing.alarms.length > 0);
  for (let n = 0; n < 70; n++) {
    f.advance();
    await f.recreate().recover();
  }
  await f.publication.finishAuthorityTransition(f.transitionId);
  assert.equal(f.denials.size, 66);
  assert.equal(new Set(f.requests).size, 66);
  assert.deepEqual(f.snapshot().request, original.request);
  assert.equal(f.snapshot().remote?.complete, true);
  const validation = await f.db
    .prepare(
      "SELECT policy,complete FROM learning_authority_validation WHERE operation_id=?",
    )
    .bind(f.op.operation_id)
    .first<{ policy: number; complete: number }>();
  assert.ok(validation);
  assert.equal(validation.policy, AUTHORITY_VALIDATION_POLICY);
  assert.equal(validation.complete, 1);
});

test("valid signed originals with lost account binding cannot deliver; restoring the original credential lets the same guarded operation complete", async (t) => {
  const f = await guardedPaginationFixture(t);
  await pages(f);
  const original = f.snapshot();
  await f.db
    .prepare(
      "UPDATE credential_bindings SET subject=? WHERE binding_id='binding'",
    )
    .bind(accounts[8].address.toLowerCase())
    .run();
  for (let n = 0; n < 5; n++) {
    f.advance();
    await f.recreate().recover();
  }
  assert.equal(f.denials.size, 0);
  assert.equal(f.snapshot().remote?.complete, false);
  assert.deepEqual(f.snapshot().request, original.request);
  await f.db
    .prepare(
      "UPDATE credential_bindings SET subject=? WHERE binding_id='binding'",
    )
    .bind(f.action.wallet)
    .run();
  for (let n = 0; n < 70; n++) {
    f.advance();
    await f.recreate().recover();
  }
  await f.publication.finishAuthorityTransition(f.transitionId);
  assert.equal(f.denials.size, 66);
  assert.equal(new Set(f.requests).size, 66);
  assert.deepEqual(f.snapshot().request, original.request);
  assert.equal(f.snapshot().remote?.complete, true);
});
