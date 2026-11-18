import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import { createNativePublicationActivityRoute, type NativePublicationFirstGrant } from "../deploy/linux/web2-native-publication-host.ts";
import type { Web2LocalStudyPolicy } from "../deploy/linux/web2-local-study.ts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import type { Hex } from "viem";
import {
  nativePublicationRetainedLookup, publicationHostOrigin, publicationHostPath, publicationLookupPath, type PublicationNativeReference,
} from "../services/native-publication-reference.ts";
import { publicationSelectionHash, publicationSelectionSource } from "../services/publication-app-selection.ts";
import { installPublicationSelection } from "../services/publication-installed-selection.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { readPublicationJob } from "../services/publication-command-operator.ts";
import { deferred } from "./fixtures/publication-app-http.ts";
import { issuer, other, payer, publicationAppFixture } from "./fixtures/publication-app.ts";
import { availablePort } from "./fixtures/linux-web2-installation.ts";

const execute = promisify(execFile);

const scenarios = [
  ["accepted proof", "checks the exact accepted app grant and live session without dispatch"],
  ["first grant admission", "admits only the fresh owner's exact live app grant reference"],
  ["issuer", "keeps its listener and operator custody through a late issuer"],
  ["handler", "drains the installed handler before releasing its slot and closing"],
  ["archived issuer", "holds an original when its retained issuer is unavailable"],
  ["archived operator", "holds an original when its retained operator is unavailable"],
  ["archived transport", "holds an original when its retained transport is unavailable"],
] as const;
for (const [scenario, description] of scenarios) {
  test("native publication " + description, {timeout: 35_000}, async t => {
    const app = await publicationAppFixture(t);
    const prepared = await app.prepare("native-timeout");
    assert.equal(prepared.status, 200);
    const command = parseCommand(prepared.value.command);
    assert.equal((await app.submit({commandId: command.commandId, signature: await app.sign(command)})).status, 200);
    if (scenario !== "accepted proof" && scenario !== "first grant admission")
      await app.historicalRecordedOriginal(command);
    const retained = (await app.rows()).find(row => row.command_id === command.commandId);
    assert(retained?.phase === "accepted");
    const release = app.ports.catalog.forOperatorSource(digest(command.source));
    const body = {commandId: command.commandId};
    const ref: PublicationNativeReference = {
      schema: "pirate.native-publication-reference/1", path: "/publication/v1/reconcile",
      commandId: command.commandId, nonce: retained.nonce_hex, sourceSha256: digest(publicationSelectionSource(release)),
      bodySha256: digest(body),
    };
    const original = readPublicationJob(app.store(), ref.commandId);
    assert.ok(original);
    const prior = app.ports.installation!;
    const archived = scenario.startsWith("archived ");
    const selectedIssuer = scenario === "archived issuer" ? other : issuer;
    const issuerAddress = selectedIssuer.address.toLowerCase() as typeof issuer.address;
    const operatorAddress = (scenario === "archived operator" ? other : payer).address.toLowerCase() as typeof payer.address;
    const originalEntry = {release, transportRef: prior.transportFor(publicationSelectionHash(release))};
    const transportRef = scenario === "archived transport" ? "operator-secondary" : originalEntry.transportRef;
    const issuerCapabilityRef = "fixture-issuer";
    const replacement = {...release, issuer: issuerAddress, operator: operatorAddress, fee: {...release.fee, payer: operatorAddress},
      withdrawalWindowSeconds: String(BigInt(release.withdrawalWindowSeconds) + 1n)};
    const entries = archived ? [originalEntry, {release: replacement, transportRef}] : [originalEntry];
    const active = archived ? publicationSelectionHash(replacement) : prior.catalog.active;
    const installation = archived ? await installPublicationSelection(app.ports.db, {
      schema: "pirate.publication-installation/1", ...app.context, installationId: prior.expected.installationId,
      incarnation: "2", installedBindingSha256: digest("fixture-replacement"), active, entries, previous: prior.expected,
    }) : prior;
    const ports = {...app.ports, installation, catalog: installation.catalog};

    const root = await mkdtemp(join(await realpath(tmpdir()), "pwp-"));
    t.after(() => rm(root, {recursive: true, force: true}));
    const activity = join(root, "activity-transport");
    const socket = join(activity, "host.sock");
    const program = join(root, "transcribe");
    const model = join(root, "ggml-base.en-q5_1.bin");
    const python = join(root, "whisper-env", "bin", "python");
    const studyAuthFile = join(root, "study.auth");
    const forwardFile = join(root, "forward.auth");
    const reverseFile = join(root, "reverse.auth");
    const forward = randomBytes(32).toString("hex"), reverse = randomBytes(32).toString("hex");
    const studyAuth = randomBytes(32).toString("base64url");
    await mkdir(activity, {mode: 0o700});
    await mkdir(join(root, "whisper-env", "bin"), {recursive: true, mode: 0o700});
    await symlink(await realpath("/usr/bin/python3"), python);
    await Promise.all([
      writeFile(program, "#!" + python + "\nraise RuntimeError('study route not used in this fixture')\n", {mode: 0o700}),
      writeFile(model, "Study selection pin for publication transport only", {mode: 0o600}),
      writeFile(studyAuthFile, studyAuth, {mode: 0o600}),
      writeFile(forwardFile, forward, {mode: 0o600}),
      writeFile(reverseFile, reverse, {mode: 0o600}),
    ]);
    const [programHash, englishModel, ffmpeg, interpreter] = await Promise.all(
      [program, model, "/usr/bin/ffmpeg", python].map(async path => hash(await readFile(path))),
    );
    for (const [name, value] of Object.entries({
      PIRATE_LOCAL_STUDY_ASR: program,
      PIRATE_LOCAL_STUDY_ASR_SHA256: programHash,
      PIRATE_LOCAL_STUDY_MODEL_SHA256: englishModel,
      PIRATE_LOCAL_STUDY_FFMPEG_SHA256: ffmpeg,
      PIRATE_LOCAL_STUDY_PYTHON_SHA256: interpreter,
    })) {
      const previous = process.env[name];
      t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
      process.env[name] = value;
    }

    const certFile = join(root, "upstream.pem"), keyFile = join(root, "upstream.key");
    await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-days", "1", "-subj", "/CN=upstream.test", "-addext", "subjectAltName=DNS:upstream.test",
      "-keyout", keyFile, "-out", certFile], {timeout: 5000, maxBuffer: 65536});
    const cert = await readFile(certFile);
    let lookups = 0;
    const upstream = createServer({key: await readFile(keyFile), cert}, async (incoming, outgoing) => {
      lookups++;
      try {
        assert.equal(incoming.url, publicationLookupPath);
        const parts: Buffer[] = [];
        for await (const part of incoming) parts.push(Buffer.from(part));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const response = await nativePublicationRetainedLookup(new Request(app.context.origin + incoming.url, {
          method: incoming.method, headers, body: Buffer.concat(parts).toString("utf8"),
        }), ports, reverse);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { outgoing.writeHead(500).end(); }
    });

    const gate = deferred(), entered = deferred();
    let reads = 0, signs = 0;
    let host: Awaited<ReturnType<typeof startWeb2NativeActivityHost>> | undefined;
    let closing: Promise<void> | undefined;
    try {
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const address = upstream.address();
      assert(address && typeof address !== "string");
      const holder = await processIdentity(process.pid);
      assert(holder);
      const lease = await acquireOperation(root, "publication-timeout", "publication-timeout", {}, holder.pidNamespace);
      const httpPort = await availablePort(), httpsPort = await availablePort();
      assert.notEqual(httpPort, httpsPort);
      const ingress: PublicIngress = {
        schema: "pirate.linux-public-ingress/1", origin: app.context.origin,
        upstream: "https://127.0.0.1:" + address.port, upstreamServerName: "upstream.test",
        upstreamCaFile: certFile, upstreamCaSha256: hash(cert), executable: join(root, "unused-caddy"),
        executableSha256: "1".repeat(64), configurationFile: join(root, "unused-Caddyfile"),
        dataDirectory: root, httpPort, httpsPort, tls: {kind: "local-fixture-ca"},
      };
      const study: Web2LocalStudyPolicy = {
        schema: "pirate.web2-local-study-policy/1", issuer: issuer.address, issuerFile: join(root, "unused-issuer"),
        operator: payer.address,
        asr: {origin: "https://asr.fixture.test", upstream: "unix:" + socket, authFile: studyAuthFile,
          authSha256: hashText(studyAuth), selectedProgramSha256: hashJson({program: programHash, englishModel, ffmpeg, python: interpreter})},
        speech: {keyGeneration: "fixture", dailyUnits: 2, websiteStudyReservedUnits: 1},
      };
      let admittedGrant: NativePublicationFirstGrant | undefined;
      const publication = await createNativePublicationActivityRoute({lease, socket, ingress,
        ...(scenario === "first grant admission" ? { async firstGrant() {
          assert(admittedGrant, "fixture grant admission is missing");
          return admittedGrant;
        }} : {}),
        requestCapabilityFile: forwardFile, lookupCapabilityFile: reverseFile,
        selection: {transportRef, issuerCapabilityRef, issuerAddress, operatorAddress}, retainedSelection: {entries, active},
        assertCurrent: () => installation.check(),
        issuer: {address: issuerAddress, capabilityRef: issuerCapabilityRef, async signMessage(input) {
          signs++;
          if (scenario === "issuer") { entered.resolve(); await gate.promise; }
          return selectedIssuer.signMessage(input);
        }},
        operator: {operatorAddress, store: app.store(), clock: () => Number(app.now()), async read(method) {
          reads++;
          assert.equal(method, "eth_chainId");
          entered.resolve();
          await gate.promise;
          throw Error("fixture RPC stopped at the original read");
        }},
      });
      if (scenario === "first grant admission") {
        const session = await ports.db.prepare(
          "SELECT session_hash FROM community_sessions WHERE account_id=?",
        ).bind(retained.account_id).first<{ session_hash: Hex }>();
        assert(session);
        const accept = (bodySha256 = original.bodyHash) => publication.fetch(
          new Request(publicationHostOrigin + publicationHostPath, {
            method: "POST", headers: { authorization: "Bearer " + forward, "content-type": "application/json" },
            body: canonical({ ...ref, path: "/publication/v1/accept", bodySha256 }),
          }),
        );
        assert.equal((await accept()).status, 503);
        admittedGrant = { commandId: ref.commandId, nonce: ref.nonce, sourceSha256: ref.sourceSha256,
          bodySha256: original.bodyHash, sessionHash: session.session_hash };
        assert.equal((await accept(digest("changed accept body"))).status, 503);
        assert.deepEqual({ signs, reads, lookups }, { signs: 0, reads: 0, lookups: 0 });
        const response = await accept();
        assert.equal(response.status, 200);
        assert.equal((await response.json() as { state: string }).state, "queued");
        assert.deepEqual({ signs, reads, lookups }, { signs: 1, reads: 0, lookups: 3 });
        await app.revokeSession();
        assert.equal((await accept()).status, 503);
        assert.deepEqual({ signs, reads, lookups }, { signs: 1, reads: 0, lookups: 4 });
        assert.deepEqual(readPublicationJob(app.store(), ref.commandId), original);
        await lease.assertHeld();
        return;
      }
      if (scenario === "accepted proof") {
        const session = await ports.db.prepare(
          "SELECT session_hash FROM community_sessions WHERE account_id=?",
        ).bind(retained.account_id).first<{ session_hash: Hex }>();
        assert(session);
        const signal = t.signal, store = app.store();
        await publication.assertAcceptedAppGrant(store, original, session.session_hash, signal);
        await assert.rejects(
          publication.assertAcceptedAppGrant(new Proxy(store, {}), original, session.session_hash, signal),
          /native_publication_operator_store_changed/,
        );
        await assert.rejects(
          publication.assertAcceptedAppGrant(store, { ...original, bodyHash: digest("changed") }, session.session_hash, signal),
          /native_publication_accepted_job_changed/,
        );
        await assert.rejects(
          publication.assertAcceptedAppGrant(store, original, digest("different session"), signal),
          /native_publication_retained_lookup_unavailable/,
        );
        await app.revokeSession();
        await assert.rejects(
          publication.assertAcceptedAppGrant(store, original, session.session_hash, signal),
          /native_publication_retained_lookup_unavailable/,
        );
        assert.deepEqual({ signs, reads, lookups }, { signs: 0, reads: 0, lookups: 3 });
        assert.deepEqual(readPublicationJob(app.store(), ref.commandId), original);
        assert.deepEqual((await app.rows()).find(row => row.command_id === ref.commandId), retained);
        await lease.assertHeld();
        return;
      }
      host = await startWeb2NativeActivityHost({selected: {schema: "pirate.web2-native-activities/1", socket},
        stateRoot: root, study, host: {}, ingress, lease, publication});

      function send(path: string, payload: string) {
        return new Promise<{status: number; body: string}>((resolve, reject) => {
          const client = request({socketPath: socket, path, agent: false, method: "POST",
            headers: {authorization: "Bearer " + forward, "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)}}, response => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", chunk => { body += chunk; });
            response.once("error", reject);
            response.once("end", () => resolve({status: response.statusCode!, body}));
          });
          client.once("error", reject);
          client.setTimeout(14_000, () => client.destroy(Error("fixture_publication_client_timeout")));
          client.end(payload);
        });
      }

      const first = send(publicationHostPath, canonical(ref));
      if (archived) {
        const failure = await first;
        assert.equal(failure.status, 503);
        assert.deepEqual(JSON.parse(failure.body), {error: "native_publication_retained_authority_unavailable"});
        assert.deepEqual({signs, reads, lookups}, {signs: 0, reads: 0, lookups: 0});
        assert.deepEqual(readPublicationJob(app.store(), ref.commandId), original);
        assert.deepEqual((await app.rows()).find(row => row.command_id === ref.commandId), retained);
        await lease.assertHeld();
        return;
      }
      await Promise.race([
        entered.promise,
        first.then(reply => { throw Error("original did not reach deferred phase: " + reply.status); }),
      ]);
      assert.equal((await first).status, 504, "listener reports its own deadline while the original remains held");
      assert.equal((await send(publicationHostPath, canonical(ref))).status, 429, "no second publication starts");
      assert.equal(signs, 1);
      assert.equal(reads, scenario === "issuer" ? 0 : 1);
      await lease.assertHeld();
      let closed = false;
      closing = host.close().then(() => { closed = true; });
      await delay(50);
      assert.equal(closed, false, "host close is waiting for the original");
      gate.resolve();
      await closing;
      assert.equal(closed, true);
      assert.equal(reads, scenario === "issuer" ? 0 : 1, "late signer or handler cannot start another operation");
      assert.deepEqual(readPublicationJob(app.store(), ref.commandId), original);
      assert.deepEqual((await app.rows()).find(row => row.command_id === ref.commandId), retained);
      await lease.assertHeld();
    } finally {
      gate.resolve();
      try {
        if (closing) await closing;
        else await host?.close();
      } finally {
        upstream.closeAllConnections();
        if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    }
  });
}
