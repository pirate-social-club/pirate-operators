// Token HTTP is real loopback; WebSocket upgrade is an explicit accept-only double.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  makeElevenLabsKaraokeSocketConnect,
  KaraokeTokenRefusal,
} from "../packages/karaoke/elevenlabs-realtime.ts";

const bounded = { timeout: 5000 };
async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("fixture_watchdog")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(
  t: TestContext,
  serve: (q: IncomingMessage, s: ServerResponse) => void,
  tokenFetch: typeof fetch = fetch,
) {
  let mints = 0,
    upgrades = 0,
    accepts = 0;
  const observed: { post: boolean; path: boolean; key: boolean }[] = [];
  const server = createServer((q, s) => {
    observed.push({
      post: q.method === "POST",
      path: q.url === "/v1/single-use-token/realtime_scribe",
      key: q.headers["xi-api-key"] === "fixture",
    });
    serve(q, s);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const input = {
    url: "ws://127.0.0.1:" + address.port + "/realtime",
    apiKey: "fixture",
  };
  const request = (async (url, init) => {
    if (new Headers(init?.headers).get("upgrade") === "websocket") {
      upgrades++;
      assert.equal(
        new URL(String(url)).searchParams.get("token"),
        "single-use",
      );
      assert.equal(new Headers(init?.headers).has("xi-api-key"), false);
      return {
        status: 101,
        webSocket: {
          accept() {
            accepts++;
          },
        },
      } as unknown as Response;
    }
    mints++;
    return tokenFetch(url, init);
  }) as typeof fetch;
  const counts = () => ({ mints, upgrades, accepts, observed });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const artifact =
      ".local/karaoke-token-boundary/" +
      t.name.replace(/[^a-z0-9-]/gi, "-") +
      ".json";
    const bytes =
      JSON.stringify({
        schema: "pirate.karaoke-token-boundary/1",
        boundary: "loopback token HTTP; explicit upgrade double",
        ...counts(),
      }) + "\n";
    await mkdir(".local/karaoke-token-boundary", { recursive: true });
    await writeFile(artifact, bytes);
    t.diagnostic(
      JSON.stringify({
        artifact,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  });
  return { input, request, counts };
}
async function refused(
  f: Awaited<ReturnType<typeof fixture>>,
  timeoutMs = 200,
) {
  const outcome = await within(
    makeElevenLabsKaraokeSocketConnect(f.request, {
      tokenTimeoutMs: timeoutMs,
    })(f.input).then(
      () => ({ ok: true as const }),
      (error) => ({ error }),
    ),
  );
  assert.ok("error" in outcome, "token phase unexpectedly upgraded");
  assert.ok(
    !(outcome.error instanceof KaraokeTokenRefusal),
    "unknown failure became confirmed refusal",
  );
  assert.equal(f.counts().mints, 1);
  assert.equal(f.counts().upgrades, 0);
  assert.equal(f.counts().accepts, 0);
}
test("stalled token headers/body never upgrade", bounded, async (t) => {
  for (const mode of ["headers", "body"])
    await t.test(mode, async (t) => {
      const f = await fixture(t, (_q, s) => {
        if (mode === "body") {
          s.writeHead(200);
          s.flushHeaders();
          s.write('{"token":"');
        }
      });
      await refused(f);
      assert.equal(f.counts().observed.length, 1);
    });
});
test("65536-byte ceiling counts ASCII and UTF8", bounded, async (t) => {
  for (const [label, padding] of [
    ["ascii", "x".repeat(65537)],
    ["utf8", "é".repeat(32768)],
  ])
    await t.test("bytes-" + label, async (t) => {
      const body = JSON.stringify({ token: "single-use", padding });
      assert.ok(Buffer.byteLength(body) > 65536);
      const f = await fixture(t, (_q, s) => {
        s.writeHead(200);
        s.write(body.slice(0, 20));
        s.end(body.slice(20));
      });
      await refused(f, 20000);
    });
});
test("malformed/network failures stay unconfirmed", bounded, async (t) => {
  const vectors: [string, string | Uint8Array | null][] = [
    ["json", "not-json"],
    ["utf8", new Uint8Array([0xc3, 0x28])],
    ["null", "null"],
    ["array", "[]"],
    ["missing", "{}"],
    ["blank", '{"token":" "}'],
    ["typed", '{"token":7}'],
    ["network", null],
  ];
  for (const [label, body] of vectors)
    await t.test("document-" + label, async (t) => {
      const f = await fixture(t, (q, s) => {
        if (body === null) q.socket.destroy();
        else s.end(body);
      });
      await refused(f);
    });
  await t.test("abort", async (t) => {
    const f = await fixture(t, (_q, s) => s.end(), (async () => {
      throw new DOMException("fixture abort", "AbortError");
    }) as typeof fetch);
    await refused(f);
  });
});
test("late token after abort never upgrades", bounded, async (t) => {
  let delivered: Promise<void> = Promise.resolve();
  const f = await fixture(t, (_q, s) => s.end(), (async () => {
    delivered = new Promise<void>((resolve) => setTimeout(resolve, 80));
    await delivered;
    return Response.json({ token: "single-use" });
  }) as typeof fetch);
  await refused(f, 10);
  await delivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.counts().upgrades, 0);
});
test("timely HTTP refusals retain exact evidence", bounded, async (t) => {
  for (const status of [400, 401, 403, 413, 415, 422, 429, 500])
    await t.test(String(status), async (t) => {
      const f = await fixture(t, (_q, s) => {
        s.writeHead(status);
        s.flushHeaders();
        s.write("discarded");
      });
      const result = await within(
        makeElevenLabsKaraokeSocketConnect(f.request, { tokenTimeoutMs: 200 })(
          f.input,
        ).then(
          () => null,
          (error) => error,
        ),
      );
      assert.ok(result instanceof Error);
      if (status === 500) assert.ok(!(result instanceof KaraokeTokenRefusal));
      else {
        assert.ok(result instanceof KaraokeTokenRefusal);
        assert.deepEqual(result.evidence, {
          schema: "pirate.karaoke-token-refusal/1",
          phase: "token-mint",
          httpStatus: status,
          providerStreamOpened: false,
        });
      }
      assert.equal(f.counts().mints, 1);
      assert.equal(f.counts().upgrades, 0);
    });
});
test("stalled cleanup cannot stall refusal", bounded, async (t) => {
  const f = await fixture(
    t,
    (_q, s) => s.end(),
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise<void>(() => {});
          },
        }),
        { status: 401 },
      )) as typeof fetch,
  );
  const result = await within(
    makeElevenLabsKaraokeSocketConnect(f.request)(f.input).then(
      () => null,
      (error) => error,
    ),
  );
  assert.ok(result instanceof KaraokeTokenRefusal);
  assert.equal(f.counts().upgrades, 0);
  assert.equal(f.counts().mints, 1);
});
test("65536-byte valid token upgrades once", bounded, async (t) => {
  const base = JSON.stringify({ token: "single-use", padding: "" });
  const body = JSON.stringify({
    token: "single-use",
    padding: "x".repeat(65536 - base.length),
  });
  assert.equal(Buffer.byteLength(body), 65536);
  const f = await fixture(t, (_q, s) => s.end(body));
  await within(makeElevenLabsKaraokeSocketConnect(f.request)(f.input));
  assert.equal(f.counts().mints, 1);
  assert.equal(f.counts().upgrades, 1);
  assert.equal(f.counts().accepts, 1);
  assert.deepEqual(f.counts().observed, [
    { post: true, path: true, key: true },
  ]);
});
test("default 20s abort covers ignored cancellation", bounded, async (t) => {
  for (const tokenTimeoutMs of [0, -1, NaN, Infinity, 20001])
    assert.throws(
      () => makeElevenLabsKaraokeSocketConnect(fetch, { tokenTimeoutMs }),
      /token_bound_invalid/,
    );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: {
    signal?: AbortSignal | null;
    mints: number;
    upgrades: number;
  } = { mints: 0, upgrades: 0 };
  const request = (async (_url, init) => {
    if (new Headers(init?.headers).get("upgrade") === "websocket")
      observed.upgrades++;
    observed.mints++;
    observed.signal = init?.signal;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const pending = makeElevenLabsKaraokeSocketConnect(request)({
    url: "ws://127.0.0.1/realtime",
    apiKey: "fixture",
  }).then(
    () => null,
    (error) => error,
  );
  assert.ok(observed.signal);
  t.mock.timers.tick(19999);
  assert.equal(observed.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(observed.signal.aborted, true);
  const error = await pending;
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof KaraokeTokenRefusal));
  assert.equal(observed.mints, 1);
  assert.equal(observed.upgrades, 0);
  t.diagnostic(
    JSON.stringify({
      boundary: "token-only fetch double",
      defaultTimeoutMs: 20000,
      mints: 1,
      upgrades: 0,
    }),
  );
});
