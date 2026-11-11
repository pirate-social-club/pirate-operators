import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { revalidationFixture } from "./learning-authority-revalidation-fixture.ts";

/** UNRUN. Requires the exact 241 protected fixture proposals. This reuses the
 * shared actual migration18, signed V4 originals, D1-shaped SQLite, account
 * reader and real delivery validator. Only signed operator transport is a
 * retained fixture; no allow callback or fabricated authority marker is used. */
export async function guardedPaginationFixture(t: TestContext) {
  const shared = await revalidationFixture(65, false, false, {
    stagePages: false,
    linked: true,
  });
  t.after(shared.closeAll);
  assert.ok(shared.grant);
  return {
    ...shared,
    ...shared.model,
    publication: shared.publication,
    grant: shared.grant,
    actor: shared.actor,
    accountId: shared.action.accountId,
  };
}
