import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOperation, processIdentity } from "../deploy/linux/backend-state.ts";
import { canonicalDigest } from "../deploy/linux/installed-records.ts";
import { assertWeb2IngressUncreated, createWeb2ExpansionPreparation, type Web2ExpansionIntent } from "../deploy/linux/web2-expansion-preparation.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "web2-expansion-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const holder = await processIdentity(process.pid);
  assert(holder);
  const lease = await acquireOperation(directory, "expansion-fixture", "installed-fixture", { localOnly: true }, holder.pidNamespace);
  const intent: Web2ExpansionIntent = {
    schema: "pirate.web2-expansion-bootstrap/1", installationId: lease.installationId, operationId: lease.operationId,
    nativeOriginalSha256: canonicalDigest("original"), graphSha256: canonicalDigest("graph"), attachmentSha256: canonicalDigest("attachment"),
  };
  return { directory, lease, intent, path: join(directory, "web2-expansion-bootstrap.json") };
}

test("the same approved expansion durably records one bootstrap before opening its producer", async t => {
  const { directory, lease, intent, path } = await fixture(t);
  const prepare = createWeb2ExpansionPreparation(directory, lease);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let effects = 0, authorized = 0;
  const input = {
    intent,
    async authorize() { authorized++; },
    assertCurrent: lease.assertHeld,
    async execute() {
      effects++;
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), intent);
      entered.resolve();
      await finish.promise;
    },
  };
  const first = prepare(input);
  await entered.promise;
  assert.equal(prepare(input), first);
  assert.throws(() => prepare({ ...input, intent: { ...intent, graphSha256: canonicalDigest("later graph") } }),
    /native_expansion_original_changed/);
  finish.resolve();
  await first;
  assert.equal(effects, 1);
  assert.equal(authorized, 1);
});

test("an occupied or interrupted expansion cannot open another producer after restart", async t => {
  const { directory, lease, intent, path } = await fixture(t);
  const bootstrap = () => createWeb2ExpansionPreparation(directory, lease);
  const guarded = { intent, authorize: lease.assertHeld, execute: async () => assert.fail("unexpected bootstrap effect") };
  await assert.rejects(bootstrap()({ ...guarded, async assertCurrent() { throw Error("owned application exists"); } }),
    /owned application exists/);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const interrupted = bootstrap();
  const operation = interrupted({ ...guarded, assertCurrent: lease.assertHeld, async execute() { throw Error("lost original reply"); } });
  await assert.rejects(operation, /lost original reply/);
  const retained = await readFile(path);
  assert.equal(interrupted({ ...guarded, assertCurrent: lease.assertHeld }), operation);
  await assert.rejects(bootstrap()({ ...guarded, assertCurrent: lease.assertHeld }), /native_expansion_bootstrap_requires_reconciliation/);
  assert.deepEqual(await readFile(path), retained);
});

test("pre-create expansion refuses an occupied private application ingress", async t => {
  const { directory } = await fixture(t);
  const server = createServer(socket => socket.destroy());
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const binding = server.address();
  assert(binding && typeof binding !== "string");
  const ingress: PublicIngress = {
    schema: "pirate.linux-public-ingress/1", origin: "https://localhost:" + binding.port,
    upstream: "https://127.0.0.1:" + binding.port, upstreamServerName: "upstream.fixture.test",
    dataDirectory: directory, configurationFile: join(directory, "new-caddyfile"),
    upstreamCaFile: join(directory, "ca.pem"), upstreamCaSha256: canonicalDigest("fixture-ca"),
    executable: "/unused-fixture", executableSha256: canonicalDigest("fixture-program"),
    httpPort: binding.port, httpsPort: binding.port, tls: { kind: "local-fixture-ca" },
  };
  await assert.rejects(assertWeb2IngressUncreated(ingress), /native_expansion_ingress_already_active/);
});
