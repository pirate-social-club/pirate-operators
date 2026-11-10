// The one reviewed successor of the published first-song state. Public files only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hashJson } from "../packages/community/common.ts";
import {
  publishedStateHash,
  publishedStateRepairHash,
  publishedStateRepairPath,
  repairedSummaries,
} from "../harness/published-state.ts";

const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const state = await read(
    "docs/deployments/first-song-managed-20261105.published-state.json",
  ),
  repair = await read(publishedStateRepairPath);

test("the repair changes only the two managed spending summaries and leaves the published state pinned", () => {
  assert.equal(hashJson(state), publishedStateHash);
  assert.equal(hashJson(repair), publishedStateRepairHash);
  assert.equal(repair.predecessorStateSha256, publishedStateHash);
  const managed = repairedSummaries(state, "managed", repair);
  for (const [table, summary] of Object.entries(state.managed))
    assert.deepEqual(
      managed[table],
      table in repair.summaries ? repair.summaries[table].to : summary,
      table,
    );
  assert.deepEqual(Object.keys(repair.summaries).sort(), [
    "spending_budgets",
    "spending_reservations",
  ]);
  assert.equal(
    managed.spending_budgets!.sha256,
    "0x6333b09e0486095e853283c48f688a3869bd66117f660a69d91bb6b1f221c56d",
  );
  assert.equal(
    managed.spending_reservations!.sha256,
    "0xb400cd11e35698a579a3a88a26bedb394d1e202c8f13fedb37acfd2e09c44bf6",
  );
  // The application side and an absent repair keep the pinned summaries.
  assert.deepEqual(
    repairedSummaries(state, "application", repair),
    state.application,
  );
  assert.deepEqual(repairedSummaries(state, "managed"), state.managed);
});

test("a changed repair or a changed predecessor state is refused", () => {
  const tampered = structuredClone(repair);
  tampered.summaries.spending_budgets.to.sha256 = "0x" + "00".repeat(32);
  assert.throws(
    () => repairedSummaries(state, "managed", tampered),
    /published_state_repair_changed/,
  );
  const otherState = structuredClone(state);
  otherState.managed.spending_budgets.count = 7;
  assert.throws(
    () => repairedSummaries(otherState, "managed", repair),
    /published_state_repair_changed/,
  );
});
