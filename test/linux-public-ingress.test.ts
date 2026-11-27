import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  hash,
  processIdentity,
  type ProcessIdentity,
} from "../deploy/linux/backend-state.ts";
import { signRecord, verifyRecord } from "../deploy/linux/installed-records.ts";
import {
  inspectCommunityIngress,
  inspectTrustedRevisionOneIngress,
  retainPublicIngress,
  startPublicIngress,
  waitForCommunityIngress,
  type PublicIngress,
} from "../deploy/linux/public-ingress.ts";
import { ingressFixture } from "./fixtures/linux-web2-installation.ts";
import { web2DirectoryFixture } from "./fixtures/web2-directory.ts";

test("trusted revision-one HTTPS witness requires exact valid UTF-8 within the decoded size bound", async (t) => {
  const { config } = await web2DirectoryFixture();
  const keys = generateKeyPairSync("ed25519");
  const trust = {
    keyId: "disposable-ingress-witness",
    spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const signed = signRecord(
    { ...config, app: { ...config.app, label: "Café 🎵 �" } },
    trust, keys.privateKey.export({ type: "pkcs8", format: "der" }),
  );
  const original = verifyRecord(signed, trust);
  const ingress: PublicIngress = {
    schema: "pirate.linux-public-ingress/1", origin: original.app.origin,
    upstream: "https://127.0.0.1:8845", upstreamServerName: "upstream.test",
    upstreamCaFile: "/fixture/ca.pem", upstreamCaSha256: "0".repeat(64),
    executable: "/fixture/caddy", executableSha256: "0".repeat(64),
    configurationFile: "/fixture/Caddyfile", dataDirectory: "/fixture/ingress",
    httpPort: 80, httpsPort: 443,
    tls: { kind: "public-acme", directory: "https://acme.example/directory", email: "operator@example.com" },
  };
  const raw = JSON.stringify(original);
  const valid = Buffer.from(raw);
  const two = valid.indexOf(Buffer.from("é"));
  const four = valid.indexOf(Buffer.from("🎵"));
  const replacement = valid.indexOf(Buffer.from("�"));
  assert(two >= 0 && four > two && replacement > four);
  const validChunks = [
    valid.subarray(0, two + 1),
    valid.subarray(two + 1, four + 2),
    valid.subarray(four + 2),
  ];
  const malformed = [valid.subarray(0, replacement), Buffer.from([0xff]), valid.subarray(replacement + 3)];
  assert.equal(Buffer.concat(malformed).toString("utf8"), raw, "replacement decoding would accept these bytes");

  // Substitute transport only. Actual byte chunks go through the production
  // reader and canonical comparison. Other ingress tests use the real TLS peer.
  type ResponseStream = PassThrough & { statusCode: number };
  const https = createRequire(import.meta.url)("node:https") as {
    request(options: RequestOptions, respond: (response: ResponseStream) => void): EventEmitter;
  };
  let chunks = validChunks;
  let path = "/.well-known/pirate-community.json";
  const request = t.mock.method(https, "request", (options: RequestOptions, respond: (response: ResponseStream) => void) => {
    assert.equal(options.path, path);
    if (path === "/.well-known/pirate-community.json") assert.equal(options.rejectUnauthorized, true);
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    const body = chunks;
    async function send() {
      respond(response);
      for (const chunk of body) {
        await nextTurn();
        if (response.destroyed) return;
        response.write(chunk);
      }
      response.end();
    }
    const outgoing = Object.assign(new EventEmitter(), {
      end() { void send().catch(error => outgoing.emit("error", error)); },
      destroy() { response.destroy(); },
    });
    return outgoing;
  });
  syncBuiltinESMExports();
  t.after(() => {
    request.mock.restore();
    syncBuiltinESMExports();
  });

  const readWitness = () => inspectTrustedRevisionOneIngress(ingress, original);
  await readWitness();
  chunks = malformed;
  await assert.rejects(readWitness, TypeError);
  chunks = [valid, Buffer.from([0xf0, 0x9f])];
  await assert.rejects(readWitness, TypeError);
  chunks = [...validChunks, Buffer.alloc(65536 - raw.length, 0x20)];
  await readWitness();
  chunks = [...validChunks, Buffer.alloc(65537 - raw.length, 0x20)];
  await assert.rejects(readWitness, /application_readback_limit/);

  path = "/api/public/community";
  chunks = malformed;
  await inspectCommunityIngress(ingress, original.communityId, true);
});

// The native launcher verifies and initializes real storage after Docker start.
// Its TLS listener must become ready without repeating any installation action.
test("native startup waits for the exact HTTPS community and refuses changed authority, identity or trust", { timeout: 20000 }, async () => {
  const f = await ingressFixture(), communityId = "0x" + "42".repeat(32);
  let refreshes = 0;
  const current = async () => { await f.lease.assertHeld(); refreshes++; };
  try {
    f.setCommunityResponse(503);
    const ready = setTimeout(() => f.setCommunityResponse(200, communityId), 500);
    try { await waitForCommunityIngress(f.ingress, communityId, current); }
    finally { clearTimeout(ready); }
    assert(f.requests() >= 2);
    assert(refreshes >= 3, "authority is checked during waiting and after success");
    const observedReadyRequests = f.requests();
    f.setCommunityResponse(200, "0x" + "43".repeat(32));
    await assert.rejects(waitForCommunityIngress(f.ingress, communityId, current), /actual_application_community_changed/);
    assert.equal(f.requests(), observedReadyRequests + 1, "a different community is never retried");
    f.setCommunityResponse(403);
    const beforeDenied = f.requests();
    await assert.rejects(waitForCommunityIngress(f.ingress, communityId, current), /application_readback_unavailable/);
    assert.equal(f.requests(), beforeDenied + 1, "an authorization refusal is never retried");
    f.setCommunityResponse(503);
    const beforeRevocation = f.requests();
    let checks = 0;
    await assert.rejects(waitForCommunityIngress(f.ingress, communityId, async () => {
      await current();
      if (++checks === 2) throw Error("original_authority_revoked");
    }), /original_authority_revoked/);
    assert.equal(f.requests(), beforeRevocation + 1);
    f.setCommunityResponse(200, communityId);
    f.replaceUpstreamTrust(false);
    const beforeBadTrust = f.requests();
    await assert.rejects(waitForCommunityIngress(f.ingress, communityId, current));
    assert.equal(f.requests(), beforeBadTrust, "an untrusted TLS peer never reaches the application");
    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(".local/linux-web2-installation/startup-readiness.json", JSON.stringify({ realTLS: true, observedReadyRequests, identityMismatchRefused: true, authorizationRefused: true, revokedWhileWaiting: true, untrustedTLSRefused: true, installationActionsRepeated: 0, scope: "HTTPS protocol fixture, not installed journey acceptance" }) + "\n");
  } finally { await f.close(); }
});

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

test("Web2 readiness keeps the final authorization inside the same sixty-second deadline", async (t) => {
  const f = await ingressFixture(), communityId = "0x" + "a".repeat(64);
  try {
    f.setCommunityResponse(200, communityId);
    const timeout = t.mock.method(AbortSignal, "timeout", () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ), 50);
      timer.unref();
      return controller.signal;
    });
    t.after(() => timeout.mock.restore());
    let finalStarted!: () => void, finishFinal!: () => void;
    const started = new Promise<void>((resolve) => { finalStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishFinal = resolve; });
    let pollingAuthorization = 0;
    const work = waitForCommunityIngress(
      f.ingress,
      communityId,
      async () => { pollingAuthorization++; },
      async () => { finalStarted(); await finish; },
    );
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    finishFinal();
    await assert.rejects(work, /aborted|timeout/i);
    assert(pollingAuthorization >= 1, "the ordinary polling authorization did not run");
    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(".local/linux-web2-installation/readiness-final-deadline.json", JSON.stringify({ finalAuthorizationInsideDeadline: true, controlledTimeoutMilliseconds: 50, ordinaryPollingAuthorizationObserved: true, scope: "actual HTTPS probe with substituted controlled timeout clock" }) + "\n");
    t.diagnostic("final authorization remained inside the readiness deadline");
  } finally {
    await f.close();
  }
});
