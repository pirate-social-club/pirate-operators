import test from "node:test";
import assert from "node:assert/strict";
import { get } from "../src/live/api.ts";

for (const status of [401, 403]) {
  test(
    `session ${status} rejects on headers without reading a stalled body`,
    { timeout: 1000 },
    async (context) => {
      let reads = 0;
      const response = new Response(null, { status });
      response.json = async () => {
        reads++;
        return new Promise(() => {});
      };
      context.mock.method(globalThis, "fetch", async () => response);
      await assert.rejects(
        get("/api/session"),
        /Sign in|temporarily unavailable/,
      );
      assert.equal(reads, 0);
    },
  );
}

test("ordinary account-change refusal retains its decoded recovery message", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "study_account_changed" }, { status: 409 }),
  );
  await assert.rejects(get("/api/session"), /different account/);
});

test("a current session response keeps its actual private identity", async (context) => {
  const session = {
    authenticated: true,
    authorId: "fixture-author",
    csrf: "fixture-csrf",
  };
  context.mock.method(globalThis, "fetch", async () => Response.json(session));
  assert.deepEqual(await get("/api/session"), session);
});
