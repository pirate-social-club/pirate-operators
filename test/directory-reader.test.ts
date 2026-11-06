import test from "node:test";
import assert from "node:assert/strict";
import { directoryFixture as fixture } from "./fixtures/directory-reader.ts";

test("canonical directory reader binds event history, raw manifest bytes, current state and block hash", async () => {
  const f = await fixture();
  assert.deepEqual(await f.read(), f.config);
  for (const fault of ["chain", "manifest", "state", "bytes", "reorg"])
    await assert.rejects((await fixture(fault)).read());
});

test("correctly committed pretty or duplicate-key configuration bytes are refused", async () => {
  for (const fault of ["pretty", "duplicates"])
    await assert.rejects(
      (await fixture(fault)).read(),
      /configuration_not_canonical/,
    );
});
test("a revocation cutoff future at its publication does not become valid at a later read head", async () => {
  await assert.rejects(
    (await fixture("cutoff")).read(),
    /invalid_revocation_block/,
  );
});
