// UNRUN at5430. Actual learning HTTP and ticket controller; only fetch is local.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  learningRequest,
  LearningServiceError,
  isLearningAuthorityLoss,
} from "../src/karaoke/operator-learning-http.ts";
import { createOperatorKaraokePort } from "../src/karaoke/operator-karaoke-adapter.ts";

const owner = "0x" + "a".repeat(40);
const open = {
  state: "open",
  ticket: { body: { ticketId: "original-ticket" } },
  socketUrl: "wss://community.invalid/attempt",
  proof: "original-proof",
  elapsedMs: 0,
};
function held(status: number) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }),
    { status },
  );
  const original = response.json.bind(response);
  let reads = 0;
  response.json = () => {
    reads++;
    return original();
  };
  return {
    response,
    reads: () => reads,
    release(body: string) {
      if (body) stream.enqueue(new TextEncoder().encode(body));
      stream.close();
    },
  };
}
for (const status of [401, 403])
  for (const body of ["", "malformed", '{"error":"session_required"}'])
    test(`${status} auth headers before held ${body || "empty"} body retain POST uncertainty`, async () => {
      const original = fetch,
        reply = held(status);
      let sessions = 0,
        posts = 0;
      globalThis.fetch = (async (path, init) => {
        if (path === "/api/session") {
          sessions++;
          return Response.json({ mossAddress: owner });
        }
        assert.equal(path, "/api/karaoke/tickets");
        assert.equal(init?.method, "POST");
        assert.equal(init?.credentials, "same-origin");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-study-account"), owner);
        assert.equal(headers.get("x-csrf-token"), "captured-csrf");
        posts++;
        return reply.response;
      }) as typeof fetch;
      try {
        const error = await learningRequest("/api/karaoke/tickets", {
          account: owner,
          csrf: "captured-csrf",
          body: { postId: "same-song" },
        }).then(
          () => assert.fail("auth headers must reject"),
          (error: unknown) => error,
        );
        assert.ok(error instanceof LearningServiceError);
        assert.equal(error.status, status);
        assert.equal(error.code, "learning_authority_lost");
        assert.equal(isLearningAuthorityLoss(error), true);
        assert.deepEqual(error.evidence, {
          stage: "response_uncertain",
          path: "/api/karaoke/tickets",
          method: "POST",
          endpointStatus: status,
        });
        assert.equal(reply.reads(), 0);
        assert.equal(sessions, 1);
        assert.equal(posts, 1);
        reply.release(body);
        await Promise.resolve();
        assert.equal(reply.reads(), 0);
        assert.equal(posts, 1);
      } finally {
        globalThis.fetch = original;
      }
    });

for (const status of [401, 403])
  test(`lost ticket POST then ${status} readback masks but keeps exact explicit recovery`, async () => {
    const original = fetch,
      denied = held(status);
    let posts = 0,
      readback = false;
    let mode: "denied" | "none" | "finished" | "open" = "denied";
    const notifications: unknown[] = [];
    globalThis.fetch = (async (path, init) => {
      if (path === "/api/session") return Response.json({ mossAddress: owner });
      if (init?.method === "POST") {
        assert.equal(path, "/api/karaoke/tickets");
        assert.deepEqual(JSON.parse(String(init.body)), {
          postId: "same-song",
        });
        posts++;
        readback = true;
        throw Error("lost acknowledgement after reservation commit");
      }
      assert.equal(path, "/api/karaoke/attempt?postId=same-song");
      if (!readback) return Response.json({ state: "none" });
      return mode === "denied"
        ? denied.response
        : Response.json(mode === "open" ? open : { state: mode });
    }) as typeof fetch;
    const port = createOperatorKaraokePort({
      account: owner,
      postId: "same-song",
      csrf: () => "captured-csrf",
      onAuthorityLoss: (error) => notifications.push(error),
    });
    try {
      const error = await port.ticket().then(
        () => assert.fail("denied readback"),
        (error: unknown) => error,
      );
      assert.ok(error instanceof LearningServiceError);
      assert.equal(error.status, status);
      assert.equal(notifications.length, 1);
      assert.equal(denied.reads(), 0);
      const originalFailure = error.cause;
      assert.ok(originalFailure instanceof LearningServiceError);
      assert.deepEqual(originalFailure.evidence, {
        stage: "response_uncertain",
        path: "/api/karaoke/tickets",
        method: "POST",
      });
      for (mode of ["none", "finished"] as const) {
        await assert.rejects(
          port.ticket(),
          (error: unknown) =>
            error instanceof Error &&
            /confirm this take/.test(error.message) &&
            error.cause === originalFailure,
        );
        assert.equal(posts, 1);
      }
      mode = "open";
      assert.deepEqual(await port.ticket(), {
        ticketId: "original-ticket",
        socketUrl: open.socketUrl,
        proof: open.proof,
      });
      assert.equal(posts, 1);
      denied.release("malformed late body");
      port.dispose();
      await assert.rejects(port.ticket(), /closed/);
      assert.equal(posts, 1);
    } finally {
      port.dispose();
      globalThis.fetch = original;
    }
  });

test("ordinary503 readback remains recoverable without an authority notification", async () => {
  const original = fetch;
  let unavailable = true,
    notifications = 0;
  globalThis.fetch = (async (path) =>
    path === "/api/session"
      ? Response.json({ mossAddress: owner })
      : unavailable
        ? Response.json({ error: "temporary_outage" }, { status: 503 })
        : Response.json(open)) as typeof fetch;
  const port = createOperatorKaraokePort({
    account: owner,
    postId: "same-song",
    csrf: () => "captured-csrf",
    onAuthorityLoss: () => {
      notifications++;
    },
  });
  try {
    await assert.rejects(port.attempt(), { status: 503 });
    assert.equal(notifications, 0);
    unavailable = false;
    assert.deepEqual(await port.attempt(), open);
  } finally {
    port.dispose();
    globalThis.fetch = original;
  }
});

test("disposing a committed ticket POST with a delayed body preserves uncertainty and never redispatches", async () => {
  const original = fetch;
  let posts = 0,
    bodyRead = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let originalBody: unknown;
  globalThis.fetch = (async (path, init) => {
    if (path === "/api/session") return Response.json({ mossAddress: owner });
    if (init?.method !== "POST") return Response.json({ state: "none" });
    assert.equal(path, "/api/karaoke/tickets");
    posts++;
    originalBody = JSON.parse(String(init.body));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
        },
      }),
    );
    const read = response.json.bind(response);
    response.json = () => {
      bodyRead = true;
      return read();
    };
    init.signal?.addEventListener(
      "abort",
      () => controller.error(new DOMException("aborted", "AbortError")),
      { once: true },
    );
    return response;
  }) as typeof fetch;
  const port = createOperatorKaraokePort({
    account: owner,
    postId: "same-song",
    csrf: () => "captured-csrf",
  });
  try {
    const pending = port.ticket().then(
      () => assert.fail("a disposed owner cannot receive the ticket"),
      (error: unknown) => error,
    );
    for (let tick = 0; !bodyRead && tick < 80; tick++) await Promise.resolve();
    assert.equal(bodyRead, true, "actual ticket body await reached");
    port.dispose();
    const error = await pending;
    assert.ok(error instanceof LearningServiceError);
    assert.deepEqual(error.evidence, {
      stage: "response_uncertain",
      path: "/api/karaoke/tickets",
      method: "POST",
      endpointStatus: 200,
    });
    await assert.rejects(port.ticket(), /closed/);
    assert.equal(posts, 1);
    assert.deepEqual(originalBody, { postId: "same-song" });
  } finally {
    port.dispose();
    globalThis.fetch = original;
  }
});
