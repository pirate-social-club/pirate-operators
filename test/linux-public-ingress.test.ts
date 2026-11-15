import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  hash,
  processIdentity,
  type ProcessIdentity,
} from "../deploy/linux/backend-state.ts";
import {
  retainPublicIngress,
  startPublicIngress,
} from "../deploy/linux/public-ingress.ts";
import { ingressFixture } from "./fixtures/linux-web2-installation.ts";

test("Web2 Caddy uses verified upstream TLS, exact Host, private-route refusal and persistent TLS on restart", async (t) => {
  const f = await ingressFixture();
  let edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
  try {
    await retainPublicIngress(f.ingress, f.lease);
    await f.preflight();
    edge = await startPublicIngress(f.ingress, f.lease, () =>
      f.lease.assertHeld(),
    );
    await f.ready();
    const originalCA = hash(await readFile(f.rootCertificate));
    const response = await f.call("/api/public/community", {
      headers: {
        Host: new URL(f.ingress.origin).host,
        Forwarded: "host=attacker.test",
        "X-Forwarded-Host": "attacker.test",
        "X-Forwarded-Proto": "http",
        "X-Forwarded-For": "203.0.113.9",
        "CF-Connecting-IP": "203.0.113.9",
        "X-Pirate-Native-Request": "forged",
        "X-Pirate-Readback-Key": "forged",
        "X-Pirate-Private-Forwarder": "forged",
      },
    });
    assert.equal(response.status, 200);
    const actual = JSON.parse(response.body) as {
      headers: Record<string, string | undefined>;
    };
    assert.equal(actual.headers.host, new URL(f.ingress.origin).host);
    for (const header of [
      "forwarded",
      "cf-connecting-ip",
      "x-pirate-native-request",
      "x-pirate-readback-key",
      "x-pirate-private-forwarder",
    ])
      assert.equal(actual.headers[header], undefined, header);
    assert.notEqual(actual.headers["x-forwarded-for"], "203.0.113.9");
    assert.notEqual(actual.headers["x-forwarded-host"], "attacker.test");
    assert.notEqual(actual.headers["x-forwarded-proto"], "http");
    const before = f.requests();
    assert.equal((await f.call("/_operator/readback/private")).status, 404);
    assert.equal(
      (await f.call("/", { headers: { Host: "attacker.test" } })).status,
      421,
    );
    assert.equal(
      f.requests(),
      before,
      "private/wrong-host request must not reach upstream",
    );
    f.replaceUpstreamTrust(false);
    assert.equal(
      (await f.call()).status,
      502,
      "untrusted upstream must fail closed",
    );
    f.replaceUpstreamTrust(true);
    await f.ready();
    const first = edge.identity;
    assert.deepEqual(await edge.stop(), { code: 0, signal: null });
    edge = undefined;
    assert.equal(await processIdentity(first.hostPid), null);
    edge = await startPublicIngress(f.ingress, f.lease, () =>
      f.lease.assertHeld(),
    );
    await f.ready();
    assert.equal(
      hash(await readFile(f.rootCertificate)),
      originalCA,
      "ordinary restart retains certificate authority",
    );
    await assert.rejects(
      retainPublicIngress(
        { ...f.ingress, origin: "https://other.test:" + f.ingress.httpsPort },
        f.lease,
      ),
      /original_ingress_configuration_changed/,
    );
    await writeFile(
      join(f.root, "proof.json"),
      JSON.stringify({
        schema: "pirate.ingress-test/1",
        binarySha256: f.ingress.executableSha256,
        originalCA,
        first,
        second: edge.identity,
        actualHTTPS: true,
        wrongHostRefused: true,
        badUpstreamTLSRefused: true,
        restartCAUnchanged: true,
      }) + "\n",
      { mode: 0o600 },
    );
    t.diagnostic("Actual TLS/restart evidence: " + f.root);
  } finally {
    try {
      await edge?.stop();
    } finally {
      await f.close();
    }
  }
});

test("Web2 ingress startup journal failure stops only its actual child and preserves the original intent", async (t) => {
  const f = await ingressFixture();
  let child: ProcessIdentity | undefined;
  try {
    const lease = {
      ...f.lease,
      async record(phase: string, facts: unknown) {
        const recorded = await f.lease.record(phase, facts);
        if (phase === "public-ingress-process") {
          assert(facts && typeof facts === "object" && "identity" in facts);
          child = facts.identity as ProcessIdentity;
          // Real storage ran; inject the lost/failing journal acknowledgement.
          throw Error("injected_ingress_journal_failure");
        }
        return recorded;
      },
    };
    await assert.rejects(
      startPublicIngress(f.ingress, lease, () => lease.assertHeld()),
      /injected_ingress_journal_failure/,
    );
    assert(child);
    assert.equal(
      await processIdentity(child.hostPid),
      null,
      "failed startup must not strand a live child",
    );
    await f.lease.assertHeld();
    await assert.rejects(
      startPublicIngress(
        { ...f.ingress, executableSha256: "0".repeat(64) },
        f.lease,
        () => f.lease.assertHeld(),
      ),
      /ingress_binary_changed/,
    );
    const denied = join(f.root, "non-executable-caddy");
    await writeFile(denied, await readFile(f.ingress.executable), {
      flag: "wx",
      mode: 0o600,
    });
    await assert.rejects(
      startPublicIngress({ ...f.ingress, executable: denied }, f.lease, () =>
        f.lease.assertHeld(),
      ),
      /EACCES/,
    );
    t.diagnostic("Actual failed-start custody evidence: " + f.root);
  } finally {
    await f.close();
  }
});

test("Web2 ingress can clean its original child after the real operation lease is lost", async () => {
  const f = await ingressFixture();
  let edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
  try {
    edge = await startPublicIngress(f.ingress, f.lease, () =>
      f.lease.assertHeld(),
    );
    await f.ready();
    await rename(
      join(f.lease.directory, "active-operation.json"),
      join(f.lease.directory, "original-lease-before-loss.json"),
    );
    await assert.rejects(f.lease.assertHeld(), { code: "ENOENT" });
    assert.deepEqual(await edge.stop(), { code: 0, signal: null });
    assert.equal(await processIdentity(edge.identity.hostPid), null);
  } finally {
    try {
      await edge?.stop();
    } finally {
      await f.close();
    }
  }
});

test("Web2 ingress bounds cleanup when the actual owned child cannot handle SIGTERM", async () => {
  const f = await ingressFixture();
  let edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
  try {
    edge = await startPublicIngress(f.ingress, f.lease, () =>
      f.lease.assertHeld(),
    );
    await f.ready();
    assert.deepEqual(
      await processIdentity(edge.identity.hostPid),
      edge.identity,
    );
    process.kill(edge.identity.hostPid, "SIGSTOP");
    const started = performance.now(),
      terminal = await edge.stop();
    assert.deepEqual(terminal, { code: null, signal: "SIGKILL" });
    assert(performance.now() - started < 12000, "cleanup must remain bounded");
    assert.equal(await processIdentity(edge.identity.hostPid), null);
  } finally {
    try {
      await edge?.stop();
    } finally {
      await f.close();
    }
  }
});
