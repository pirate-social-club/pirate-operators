// Release tool resilience: bounded read retries, Node connect defaults and the
// retained managed dependency link. No network, key or private state.
import test from "node:test";
import assert from "node:assert/strict";
import { getDefaultResultOrder } from "node:dns";
import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READ_RETRY_DELAYS_MS,
  megaethReadClient,
  readRetryingFetch,
} from "../packages/community/chain.ts";
import { releaseNetwork } from "../harness/node-network.ts";
import { linkRetainedDependencies } from "../harness/community-dependencies.ts";

const rpc = (method: string) => ({
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
});
const ok = () =>
  Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" }, { status: 200 });
function scripted(steps: ("throw" | number)[]) {
  const calls: string[] = [];
  const send = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).method);
    const step = steps.shift() ?? 200;
    if (step === "throw") throw new TypeError("fetch failed");
    return step === 200 ? ok() : new Response("busy", { status: step });
  }) as typeof fetch;
  return { send, calls };
}
const noSleep = async () => {};

test("a read is retried a bounded number of times after network or transient failures", async () => {
  const a = scripted(["throw", 503]);
  const response = await readRetryingFetch(a.send, noSleep)(
    "https://rpc.example",
    rpc("eth_blockNumber"),
  );
  assert.equal(response.status, 200);
  assert.equal(a.calls.length, 3);
  const b = scripted(["throw", "throw", "throw", 200]);
  await assert.rejects(
    readRetryingFetch(b.send, noSleep)(
      "https://rpc.example",
      rpc("eth_getLogs"),
    ),
    /fetch failed/,
  );
  assert.equal(b.calls.length, READ_RETRY_DELAYS_MS.length + 1);
  // A definite client error is not retried.
  const c = scripted([400]);
  assert.equal(
    (
      await readRetryingFetch(c.send, noSleep)(
        "https://rpc.example",
        rpc("eth_call"),
      )
    ).status,
    400,
  );
  assert.equal(c.calls.length, 1);
});

test("a transaction submission, an unknown method or a mixed batch is sent exactly once", async () => {
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "x"]) {
    const s = scripted(["throw", 200]);
    await assert.rejects(
      readRetryingFetch(s.send, noSleep)("https://rpc.example", rpc(method)),
      /fetch failed/,
      method,
    );
    assert.equal(s.calls.length, 1, method);
    const t = scripted([503, 200]);
    assert.equal(
      (await readRetryingFetch(t.send, noSleep)("https://rpc.example", rpc(method)))
        .status,
      503,
      method,
    );
    assert.equal(t.calls.length, 1, method);
  }
  const calls: unknown[] = [];
  const batch = readRetryingFetch(
    (async (_input: unknown, init?: RequestInit) => {
      calls.push(init?.body);
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    noSleep,
  );
  await assert.rejects(
    batch("https://rpc.example", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" },
        { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction" },
      ]),
    }),
  );
  assert.equal(calls.length, 1);
});

test("an aborted read stops retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  const reads = readRetryingFetch(
    (async () => {
      calls++;
      controller.abort(new Error("timed out"));
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    noSleep,
  );
  await assert.rejects(
    reads("https://rpc.example", {
      ...rpc("eth_blockNumber"),
      signal: controller.signal,
    }),
  );
  assert.equal(calls, 1);
});

test("the application client retries reads and never resends a submission", async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  let failures = 2;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    methods.push(method);
    if (failures-- > 0) throw new TypeError("fetch failed");
    if (method === "eth_sendRawTransaction")
      throw new TypeError("fetch failed");
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" });
  }) as typeof fetch;
  try {
    const client = megaethReadClient();
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 16n);
    assert.deepEqual(methods, [
      "eth_blockNumber",
      "eth_blockNumber",
      "eth_blockNumber",
    ]);
    methods.length = 0;
    await assert.rejects(
      client.sendRawTransaction({ serializedTransaction: "0x01" }),
    );
    assert.deepEqual(methods, ["eth_sendRawTransaction"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("each release tool loads the network defaults before any other module", async () => {
  for (const [path, specifier] of [
    ["harness/community-release.ts", "./node-network.ts"],
    ["harness/managed-service.ts", "./node-network.ts"],
    ["harness/megaeth/owner-policy-activation.ts", "../node-network.ts"],
  ] as const) {
    const first = (await readFile(path, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("import "));
    assert.equal(first, `import "${specifier}";`, path);
  }
});

test("release tools prefer IPv4 and give each address family three seconds to connect", () => {
  assert.equal(getDefaultResultOrder(), releaseNetwork.resultOrder);
  assert.equal(
    getDefaultAutoSelectFamilyAttemptTimeout(),
    releaseNetwork.familyAttemptTimeoutMs,
  );
});

test("the managed runner links the retained dependency tree and verifies every recorded link", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-runner-")),
    retained = join(root, "retained", "node_modules"),
    workingInstall = join(root, "working", "node_modules"),
    link = join(root, "deployment", "node_modules");
  await mkdir(retained, { recursive: true });
  await mkdir(workingInstall, { recursive: true });
  await mkdir(join(root, "deployment"), { recursive: true });
  // A previous run linked the working install; the writer replaces that link.
  await symlink(workingInstall, link);
  let verified = 0;
  await linkRetainedDependencies(link, {
    modules: retained,
    verify: async () => void verified++,
  });
  assert.equal(await readlink(link), retained);
  assert.equal(verified, 1);
  // An already-correct link is left in place and needs no second verification.
  const before = await lstat(link);
  assert.deepEqual(
    await linkRetainedDependencies(link, {
      modules: retained,
      verify: async () => void verified++,
    }),
    { changed: false },
  );
  assert.equal(verified, 1);
  assert.equal((await lstat(link)).ino, before.ino);
  // A failed verification after a change refuses.
  await symlink(workingInstall, link + ".stale");
  const { rename } = await import("node:fs/promises");
  await rename(link + ".stale", link);
  await assert.rejects(
    linkRetainedDependencies(link, {
      modules: retained,
      verify: async () => {
        throw new Error("retained_dependencies_unverified");
      },
    }),
    /retained_dependencies_unverified/,
  );
  // A real directory in place of the link is never replaced.
  const real = join(root, "other", "node_modules");
  await mkdir(real, { recursive: true });
  await assert.rejects(
    linkRetainedDependencies(real, {
      modules: retained,
      verify: async () => {},
    }),
    /unexpected_managed_dependencies/,
  );
  assert.equal((await lstat(real)).isDirectory(), true);
});
