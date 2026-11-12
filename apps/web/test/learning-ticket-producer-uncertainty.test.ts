// UNRUN. Actual owned HTTP/adapter with memory transport observations. The
// actual handler + real-D1 commit/ack witness is a separate pinned proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperatorKaraokePort } from "../src/karaoke/operator-karaoke-adapter.ts";
import {
  learningRequest,
  LearningServiceError,
} from "../src/karaoke/operator-learning-http.ts";

const original = {
  ticket: { body: { ticketId: "original-reservation" } },
  socketUrl: "wss://community.invalid/attempt",
  proof: "fixture-proof",
};
const opened = { ...original, state: "open", elapsedMs: 0 };
for (const observed of ["none", "finished"] as const)
  test(`delayed structured409 after commit stays held through ${observed} observations`, async () => {
    const savedFetch = globalThis.fetch;
    let posts = 0,
      sequence = 0,
      reservation: string | null = null;
    let release!: (value: unknown) => void,
      recover = false;
    globalThis.fetch = (async (path, init) => {
      if (path === "/api/session")
        return Response.json({ mossAddress: "fixture-account" });
      if (init?.method === "POST") {
        posts++;
        sequence++;
        reservation = "original-reservation";
        // Models the handler's409 after storage committed but its ack failed.
        return {
          ok: false,
          status: 409,
          json: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        } as Response;
      }
      return Response.json(recover ? opened : { state: observed });
    }) as typeof fetch;
    const port = createOperatorKaraokePort({
      account: "fixture-account",
      postId: "fixture-post",
      csrf: () => "fixture-csrf",
    });
    try {
      const pending = port.ticket();
      for (let tick = 0; tick < 80 && !release; tick++) await Promise.resolve();
      assert.ok(release);
      assert.equal(port.ticket(), pending);
      assert.equal(posts, 1);
      const rejected = assert.rejects(pending, /confirm this take/);
      release({ error: "wallet_reservation_ack_lost" });
      await rejected;
      await assert.rejects(port.ticket(), /confirm this take/);
      assert.equal(posts, 1);
      assert.equal(sequence, 1);
      assert.equal(reservation, "original-reservation");
      recover = true;
      assert.equal((await port.ticket()).ticketId, reservation);
      assert.equal(posts, 1);
      assert.equal(sequence, 1);
    } finally {
      port.dispose();
      globalThis.fetch = savedFetch;
    }
  });

for (const code of [
  "open_ticket_exists",
  "different_session_key",
  "wallet_allowance_exhausted",
  "karaoke_authorization_pending",
  "karaoke_authorization_required",
  "study_account_changed",
])
  test(`structured409 ${code} cannot prove a precommit refusal`, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (path) =>
      path === "/api/session"
        ? Response.json({ mossAddress: "fixture-account" })
        : Response.json({ error: code }, { status: 409 })) as typeof fetch;
    try {
      await assert.rejects(
        learningRequest("/api/karaoke/tickets", {
          account: "fixture-account",
          csrf: "fixture-csrf",
          body: { postId: "fixture-post" },
        }),
        {
          code,
          status: 409,
          evidence: {
            stage: "response_uncertain",
            path: "/api/karaoke/tickets",
            method: "POST",
            endpointStatus: 409,
          },
        },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

test("a forged endpoint-refusal stage cannot turn409 into proof at the adapter seam", async () => {
  let posts = 0;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body !== undefined) {
        posts++;
        throw new LearningServiceError(
          409,
          "wallet_allowance_exhausted",
          "unknown ack",
          {
            stage: "endpoint_refusal",
            path: "/api/karaoke/tickets",
            method: "POST",
            endpointStatus: 409,
          },
        );
      }
      return { state: "none" } as T;
    },
  });
  await assert.rejects(port.ticket());
  await assert.rejects(port.ticket());
  assert.equal(posts, 1);
  port.dispose();
});

for (const [status, code] of [
  [401, "session_required"],
  [403, "csrf_required"],
  [403, "wrong_origin"],
  [403, "wrong_host"],
  [403, "cross_site_write"],
] as const)
  test(`auth headers ${status}/${code} cannot expose a pre-handler body as reservation proof`, async () => {
    const savedFetch = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (async (path, init) => {
      if (path === "/api/session")
        return Response.json({ mossAddress: "fixture-account" });
      if (init?.method === "POST") {
        posts++;
        return Response.json({ error: code }, { status });
      }
      return Response.json({ state: "none" });
    }) as typeof fetch;
    const port = createOperatorKaraokePort({
      account: "fixture-account",
      postId: "fixture-post",
      csrf: () => "fixture-csrf",
    });
    try {
      await assert.rejects(port.ticket(), {
        status,
        code: "learning_authority_lost",
        evidence: {
          stage: "response_uncertain",
          path: "/api/karaoke/tickets",
          method: "POST",
          endpointStatus: status,
        },
      });
      assert.equal(posts, 1); // No automatic create retry.
      // The transport must mask before decoding code. Even a real pre-handler
      // refusal is conservatively held when only its auth headers are known.
      await assert.rejects(port.ticket(), /confirm this take/);
      assert.equal(posts, 1);
    } finally {
      port.dispose();
      globalThis.fetch = savedFetch;
    }
  });
