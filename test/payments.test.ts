import { test } from "node:test";
import assert from "node:assert/strict";
import { workers } from "../harness/runtime.ts";

test("accepted payment, lost response, payer restart and retry retain exactly one charge", async () => {
  let runtime = await workers();
  const persist = runtime.persist;
  const request = async (role: string, path: string, input: unknown) => {
    const worker = await runtime.mf.getWorker(role);
    return worker.fetch(`http://local${path}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
  try {
    assert.equal(
      (await request("payer", "/reserve", { jobId: "retry-case", ceiling: 10 }))
        .status,
      200,
    );
    await request("provider", "/__lose-next", {});
    assert.equal(
      (await request("payer", "/charge", { jobId: "retry-case", units: 3 }))
        .status,
      400,
    );
    await runtime.mf.dispose();
    runtime = await workers(persist);
    const retry = await request("payer", "/charge", {
      jobId: "retry-case",
      units: 3,
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { charged: 3 });
    const state = (await (
      await request("provider", "/__state", {})
    ).json()) as { key: string; value: { units: number } }[];
    const charges = state.filter((r) => r.key.startsWith("charge:"));
    assert.equal(charges.length, 1);
    assert.equal(charges[0].value.units, 3);
    const payer = (await (await request("payer", "/__state", {})).json()) as {
      key: string;
      value: unknown;
    }[];
    assert.equal(payer.find((r) => r.key === "exposure")!.value, 3);
  } finally {
    await runtime.mf.dispose();
  }
});
test("concurrent reservations cannot exceed the community budget", async () => {
  const runtime = await workers();
  try {
    const worker = await runtime.mf.getWorker("payer");
    const responses = await Promise.all(
      ["a", "b", "c"].map((jobId) =>
        worker.fetch("http://local/reserve", {
          method: "POST",
          body: JSON.stringify({ jobId, ceiling: 600 }),
        }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal(responses.filter((r) => r.status === 400).length, 2);
  } finally {
    await runtime.mf.dispose();
  }
});
