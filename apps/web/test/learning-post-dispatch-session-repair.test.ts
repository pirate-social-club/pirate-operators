// UNRUN. Actual owned HTTP+ticket adapter with memory fetch, no server/provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperatorKaraokePort } from "../src/karaoke/operator-karaoke-adapter.ts";
import {
  learningRequest,
  LearningServiceError,
} from "../src/karaoke/operator-learning-http.ts";

const issued = {
  ticket: { body: { ticketId: "original-ticket" } },
  socketUrl: "wss://community.invalid/attempt",
  proof: "fixture-proof",
};
const opened = { ...issued, state: "open", elapsedMs: 0 };
for (const status of [401, 409])
  test(`post-commit session ${status} cannot authorize another ticket POST`, async () => {
    const original = globalThis.fetch;
    let writes = 0,
      sessionFailure = false,
      observedOpen = false;
    globalThis.fetch = (async (path, init) => {
      if (path === "/api/session") {
        if (sessionFailure) {
          sessionFailure = false;
          return Response.json({ error: "session_changed" }, { status });
        }
        return Response.json({ mossAddress: "fixture-account" });
      }
      if (init?.method === "POST") {
        writes++;
        sessionFailure = true;
        return Response.json(issued);
      }
      return Response.json(observedOpen ? opened : { state: "none" });
    }) as typeof fetch;
    const port = createOperatorKaraokePort({
      account: "fixture-account",
      postId: "fixture-post",
      csrf: () => "fixture-csrf",
    });
    try {
      await assert.rejects(port.ticket(), /confirm this take/);
      await assert.rejects(port.ticket(), /confirm this take/);
      assert.equal(writes, 1);
      observedOpen = true;
      assert.equal((await port.ticket()).ticketId, "original-ticket");
      assert.equal(writes, 1);
    } finally {
      port.dispose();
      globalThis.fetch = original;
    }
  });

test("delayed successful ticket body followed by account change carries post-dispatch evidence", async () => {
  const original = globalThis.fetch;
  let release!: (value: unknown) => void,
    committed = false;
  globalThis.fetch = (async (path) => {
    if (path === "/api/session")
      return Response.json({
        mossAddress: committed ? "other-account" : "fixture-account",
      });
    committed = true;
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    } as Response;
  }) as typeof fetch;
  try {
    const pending = learningRequest("/api/karaoke/tickets", {
      account: "fixture-account",
      csrf: "fixture-csrf",
      body: { postId: "fixture-post" },
    });
    // Advance the preflight/body boundary without a clock or service fixture.
    for (let tick = 0; tick < 40 && !release; tick++) await Promise.resolve();
    assert.ok(release, "ticket response body seam was reached");
    release(issued);
    await assert.rejects(pending, {
      status: 401,
      evidence: {
        stage: "response_uncertain",
        path: "/api/karaoke/tickets",
        method: "POST",
        endpointStatus: 200,
      },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("structured budget status alone is uncertain; body failure stays uncertain", async () => {
  const original = globalThis.fetch;
  let malformed = false;
  globalThis.fetch = (async (path) => {
    if (path === "/api/session")
      return Response.json({ mossAddress: "fixture-account" });
    return malformed
      ? new Response("broken body", { status: 429 })
      : Response.json({ error: "speech_budget_exhausted" }, { status: 429 });
  }) as typeof fetch;
  try {
    const options = {
      account: "fixture-account",
      csrf: "fixture-csrf",
      body: { postId: "fixture-post" },
    };
    await assert.rejects(learningRequest("/api/karaoke/tickets", options), {
      status: 429,
      code: "speech_budget_exhausted",
      evidence: {
        stage: "response_uncertain",
        path: "/api/karaoke/tickets",
        method: "POST",
        endpointStatus: 429,
      },
    });
    malformed = true;
    await assert.rejects(learningRequest("/api/karaoke/tickets", options), {
      evidence: {
        stage: "response_uncertain",
        path: "/api/karaoke/tickets",
        method: "POST",
        endpointStatus: 429,
      },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("an unscoped 409 error cannot masquerade as endpoint refusal", async () => {
  let writes = 0;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body !== undefined) {
        writes++;
        throw new LearningServiceError(
          409,
          "session_changed",
          "Post-check failed",
        );
      }
      return { state: "none" } as T;
    },
  });
  await assert.rejects(port.ticket());
  await assert.rejects(port.ticket());
  assert.equal(writes, 1);
  port.dispose();
});
