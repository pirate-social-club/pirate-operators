/** UNRUN. c7 retained-original cases on the actual controller; named storage simulation. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDanceRecordingController } from "../src/dance/source/dance-recording.ts";
import {
  simulatedSource,
  simulatedRecordingStorage,
  scope,
} from "./dance-source-fixtures.ts";

async function fixture() {
  const f = simulatedSource(),
    s = simulatedRecordingStorage();
  await f.seed();
  const take = {
    sessionId: f.c.captureId,
    termsHash: f.c.termsHash,
    durationMs: f.c.durationSamples / 48,
    file: new File(["original camera bytes"], "take.mp4", {
      type: "video/mp4",
    }),
  };
  return {
    ...f,
    ...s,
    take,
    controller: () =>
      createDanceRecordingController({ ...f.ports, storage: s.storage }),
  };
}
test("reload verifies exact digest, consent, capture, scope and original expiry", async () => {
  const f = await fixture(),
    a = await f
      .controller()
      .retain(f.ready, f.take, new AbortController().signal);
  const b = await f
    .controller()
    .restore(f.c.captureId, new AbortController().signal);
  assert.deepEqual(a.metadata, b?.metadata);
  assert.equal(await b?.blob.text(), "original camera bytes");
  assert.equal(a.metadata.expiresAtMs, f.c.expiresAtMs);
  assert.equal(a.metadata.consentReceiptId, f.c.consent!.receiptId);
});
test("lost successful storage acknowledgement retries original without rewriting timestamp; different take refuses", async () => {
  const f = await fixture(),
    add = f.storage.add;
  let writes = 0;
  f.storage.add = async (...args) => {
    writes++;
    await add(...args);
    throw Error("write_ack_lost");
  };
  await assert.rejects(
    f.controller().retain(f.ready, f.take, new AbortController().signal),
    /write_ack_lost/,
  );
  const original = await f
    .controller()
    .retain(f.ready, f.take, new AbortController().signal);
  assert.equal(writes, 1);
  assert.equal(original.metadata.storedAtMs, 11000);
  await assert.rejects(
    f.controller().retain(
      f.ready,
      {
        ...f.take,
        file: new File(["replacement"], "new.mp4", { type: "video/mp4" }),
      },
      new AbortController().signal,
    ),
    /original_required/,
  );
});
test("quota/readback absence cannot return a saved take", async () => {
  for (const mode of ["quota", "missing"] as const) {
    const f = await fixture();
    f.storage.add = async () => {
      if (mode === "quota")
        throw new DOMException("quota", "QuotaExceededError");
    };
    await assert.rejects(
      f.controller().retain(f.ready, f.take, new AbortController().signal),
    );
    assert.equal(f.calls.includes("reserve"), false);
  }
});
test("same-size corruption, changed captured binding and foreign account cannot restore", async () => {
  const f = await fixture();
  await f.controller().retain(f.ready, f.take, new AbortController().signal);
  const r = f.records.get(f.c.captureId)!;
  f.records.set(f.c.captureId, {
    ...r,
    blob: new Blob(["x".repeat(f.take.file.size)], { type: "video/mp4" }),
  });
  await assert.rejects(
    f.controller().restore(f.c.captureId, new AbortController().signal),
    /corrupt/,
  );
  f.records.set(f.c.captureId, r);
  f.setScope({ ...scope, accountId: "other_account" });
  await assert.rejects(
    f.controller().restore(f.c.captureId, new AbortController().signal),
    /session_changed/,
  );
});
test("account/session change during actual write cannot return private bytes; original survives", async () => {
  const f = await fixture(),
    add = f.storage.add;
  f.storage.add = async (...args) => {
    await add(...args);
    f.setScope({ ...scope, sessionKey: "replaced" });
  };
  await assert.rejects(
    f.controller().retain(f.ready, f.take, new AbortController().signal),
    /session_changed/,
  );
  assert.equal(f.records.size, 1);
});
