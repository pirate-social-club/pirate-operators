import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import { createNativePublicationActivityRoute, type NativePublicationFirstGrant } from "../deploy/linux/web2-native-publication-host.ts";
import type { Web2LocalStudyPolicy } from "../deploy/linux/web2-local-study.ts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import { keccak256, type Hex } from "viem";
import { danceCommand } from "../packages/dance-chain/v2/wire.ts";
import { durableJson } from "../harness/private-json.ts";
import { DanceV2ActionStore, DANCE_V2_ACTIONS_SCHEMA_PROPOSAL } from "../services/dance-v2-action-store.ts";
import type { Web2PublicDanceCustody } from "../deploy/linux/web2-public-dance-custody.ts";
import { createNativeDanceRetainedStore } from "../deploy/linux/web2-native-dance-retained-store.ts";
import { openPinnedNativeDanceOperatorStore } from "../deploy/linux/web2-native-dance-store-connection.ts";
import { nativeDanceHostPath, nativeDanceReadyPath, type NativeDanceRetainedScope } from "../services/native-dance-retained-reference.ts";
import { nativeDanceOriginalTransport, nativeDanceReadyResponse } from "../services/linux-web2-dance-retained-transport.ts";
import {
  nativePublicationRetainedLookup, publicationHostOrigin, publicationHostPath, publicationLookupPath, type PublicationNativeReference,
} from "../services/native-publication-reference.ts";
import { publicationSelectionHash, publicationSelectionSource } from "../services/publication-app-selection.ts";
import { installPublicationSelection } from "../services/publication-installed-selection.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { readPublicationJob } from "../services/publication-command-operator.ts";
import { deferred, operatorDatabase } from "./fixtures/publication-app-http.ts";
import { issuer, other, payer, publicationAppFixture } from "./fixtures/publication-app.ts";
import { availablePort } from "./fixtures/linux-web2-installation.ts";

const execute = promisify(execFile);

const scenarios = [
  ["dance retained", "reads only exact Dance originals from the installed private Store"],
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
    let lookups = 0, danceReadyOpens = 0;
    const retainedDance = scenario === "dance retained";
    const danceScope: NativeDanceRetainedScope = {
      installationId: consentDigest(installation.expected.installationId),
      releaseSha256: publicationSelectionHash(release),
      chainId: 6343, communityId: app.context.communityId, publisher: operatorAddress,
      verifier: other.address.toLowerCase() as typeof other.address, sourceHash: digest("dance source"),
    };
    const upstream = createServer({key: await readFile(keyFile), cert}, async (incoming, outgoing) => {
      lookups++;
      try {
        assert(incoming.url === publicationLookupPath || retainedDance && incoming.url === nativeDanceReadyPath);
        const parts: Buffer[] = [];
        for await (const part of incoming) parts.push(Buffer.from(part));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const observedRequest = new Request(app.context.origin + incoming.url, {
          method: incoming.method, headers, body: Buffer.concat(parts).toString("utf8"),
        });
        const response = incoming.url === nativeDanceReadyPath
          ? await nativeDanceReadyResponse(observedRequest, reverse, async () => {
              danceReadyOpens++;
              return { db: ports.db, scope: danceScope, assertCurrent: () => installation.check() };
            })
          : await nativePublicationRetainedLookup(observedRequest, ports, reverse);
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
      const storePath = join(root, "owner.sqlite"), wrongPath = join(root, "other.sqlite");
      const selectedStore = retainedDance ? operatorDatabase(storePath, Number(app.now())) : undefined;
      const wrongStore = retainedDance ? operatorDatabase(wrongPath, Number(app.now())) : undefined;
      let closeSelectedStore: (() => void | Promise<void>) | undefined = selectedStore?.close;
      t.after(async () => {
        try { await closeSelectedStore?.(); } finally { wrongStore?.close(); }
      });
      const journal = join(root, "dance-originals");
      if (retainedDance) await mkdir(journal, {mode: 0o700});
      const journalStat = retainedDance ? await stat(journal, {bigint: true}) : undefined;
      const runId = "test-run", genesisHash = digest("dance-test-genesis");
      const storeId = digest("same visible journal identity");
      if (selectedStore && wrongStore) {
        await Promise.all([chmod(storePath, 0o600), chmod(wrongPath, 0o600)]);
        const marker = {schema:"pirate.local-publication-operator-journal/1", journalId:storeId, chainId:6343,
          genesisHash, communityId:danceScope.communityId, installationId:danceScope.installationId, publisher:danceScope.publisher};
        for (const {store} of [selectedStore, wrongStore]) store.set("publicationOperatorIdentity:v1", marker);
      }
      const storeStat = selectedStore ? await stat(storePath, {bigint: true}) : undefined;
      const custody = storeStat && journalStat ? {
        storeIdentity: {path:storePath, device:String(storeStat.dev), inode:String(storeStat.ino), journalId:storeId},
        journalDirectory: journal, directoryIdentity: {device:String(journalStat.dev), inode:String(journalStat.ino)},
        runId, genesisHash, scope: danceScope, assertCustody: () => lease.assertHeld(),
      } : undefined;
      const danceOwner = selectedStore && custody ? await createNativeDanceRetainedStore({ ...custody, store:selectedStore.store }) : undefined;
      const makePublication = (store = selectedStore?.store ?? app.store(), reader = danceOwner, routeLease = lease) =>
        createNativePublicationActivityRoute({lease: routeLease, socket, ingress, retainedDance: reader,
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
        operator: {operatorAddress, store, clock: () => Number(app.now()), async read(method) {
          reads++;
          assert.equal(method, "eth_chainId");
          entered.resolve();
          await gate.promise;
          throw Error("fixture RPC stopped at the original read");
        }},
      });
      const publication = await makePublication();
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
      let selectedRoute = publication;
      host = await startWeb2NativeActivityHost({selected: {schema: "pirate.web2-native-activities/1", socket},
        stateRoot: root, study, host: {}, ingress, lease,
        ...(retainedDance ? {deferredPublication: () => selectedRoute} : {publication})});

      function send(path: string, payload: string, access = forward) {
        return new Promise<{status: number; body: string}>((resolve, reject) => {
          const client = request({socketPath: socket, path, agent: false, method: "POST",
            headers: {authorization: "Bearer " + access, "content-type": "application/json",
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

      if (retainedDance) {
        assert(selectedStore && wrongStore && custody);
        await publication.assertRetainedDanceCustody(danceScope);
        await assert.rejects(publication.assertRetainedDanceCustody({ ...danceScope, sourceHash: digest("different public source") }),
          /native_dance_store_scope_changed/);
        const replacement = await makePublication(wrongStore.store);
        await assert.rejects(replacement.assertRetainedDanceCustody(danceScope), /native_dance_store_scope_changed/);
        const composerIntent = canonical({ runId, genesisHash, nativeOriginalSha256: hash("native original"),
          publisher: danceScope.publisher, localOnly: false });
        const originalIntent = join(journal, "selection-intent.json");
        await writeFile(originalIntent, composerIntent, { mode: 0o600 });
        const approvalPin: Web2PublicDanceCustody = {
          schema: "pirate.public-web2-dance-custody/1", nativeOriginalSha256: hash("native original"),
          hostInstallationId: lease.installationId, approvalSha256: hash("approval"), selectionSha256: digest("selection"),
          rewardSha256: hash("rewards"), scopeSha256: hash("scope"), prepareIntentSha256: hash("intent"),
          prepareResultSha256: hash("result"), scope: danceScope, store: custody.storeIdentity,
          composer: { path: journal, ...custody.directoryIdentity, runId, genesisHash, intentSha256: hash(composerIntent) },
        };
        await assert.rejects(publication.assertRetainedDanceCustody(danceScope, approvalPin),
          /native_dance_connected_store_unavailable/);

        const replacementJournal = join(root, "other-dance-originals");
        await mkdir(replacementJournal, { mode: 0o700 });
        await writeFile(join(replacementJournal, "selection-intent.json"), composerIntent, { mode: 0o600 });
        const diskIdentity = async (path: string) => {
          const disk = await stat(path, { bigint: true });
          return { device: String(disk.dev), inode: String(disk.ino) };
        };
        const copiedStore = await createNativeDanceRetainedStore({ ...custody, store: wrongStore.store,
          storeIdentity: { path: wrongPath, ...await diskIdentity(wrongPath), journalId: storeId } });
        const copiedJournal = await createNativeDanceRetainedStore({ ...custody, store: selectedStore.store,
          journalDirectory: replacementJournal, directoryIdentity: await diskIdentity(replacementJournal) });
        for (const candidate of [await makePublication(wrongStore.store, copiedStore), await makePublication(selectedStore.store, copiedJournal)]) {
          await candidate.assertRetainedDanceCustody(danceScope);
          await assert.rejects(candidate.assertRetainedDanceCustody(danceScope, approvalPin), /native_dance_publisher_identity_changed/);
        }
        for (const sql of DANCE_V2_ACTIONS_SCHEMA_PROPOSAL) await ports.db.prepare(sql).run();
        const actions = new DanceV2ActionStore(ports.db);
        async function ready(label: string) {
          const saved = actions.original(danceScope.communityId, digest(label), "verdict", "fixture-account", {verdict:"pass"});
          const resourceId = digest("submission-" + label);
          const wire = danceCommand({chainId: 6343n, communityId: danceScope.communityId, verifier: danceScope.verifier},
            "commitVerdict", danceScope.publisher, saved.command_id, {decision: {
              submissionId: resourceId, verdict: 1, reviewerAccountCommitment: digest("account"), reviewerWallet: other.address,
              reviewerPublicationGrantId: digest("grant"), reviewerIdentityEpoch: 1n, reviewerGroupId: digest("group"),
              reviewerGroupEpoch: 1n, expectedOwnerEpoch: 1n, expectedReviewerRoleEpoch: 1n, expectedMediaEpoch: 1n,
              intentAcceptedAtMs: 1n, expectedConfigurationRevision: 2n, expectedRulesEpoch: 0n, reviewerConsentHash: digest("consent"),
            }});
          await actions.reserve(saved, digest("context")).run();
          await actions.prepare({command_id: wire.id, source_hash: danceScope.sourceHash, publisher: danceScope.publisher,
            command_hash: wire.hash, encoded: wire.encoded, calldata: wire.data, resource_id: resourceId}).run();
          return { wire, original: { chainId: 6343, communityId: danceScope.communityId, verifier: danceScope.verifier,
            publisher: danceScope.publisher, sourceHash: danceScope.sourceHash, kind: "verdict" as const,
            commandId: wire.id, commandHash: wire.hash, resourceId } };
        }
        const good = await ready("good"), empty = await ready("absent"), oneSided = await ready("one-sided"),
          mirrorOnly = await ready("mirror-without-index"), fileOnly = await ready("file-without-index");
        async function signed(input: typeof good, nonce: number) {
          const raw = await payer.signTransaction({type: "legacy", chainId: 6343, nonce,
            gas: 200000n, gasPrice: 1n, to: danceScope.verifier, data: input.wire.data, value: 0n});
          return { commandId: input.wire.id, commandHash: input.wire.hash, target: danceScope.verifier,
            data: input.wire.data, raw, hash: keccak256(raw), nonce, broadcast: "attempted" };
        }
        function index(store: ReturnType<typeof operatorDatabase>["store"], value: Awaited<ReturnType<typeof signed>>) {
          store.set("local6343PublisherOriginal:" + value.commandId, value);
          store.set("local6343PublisherNonce:" + String(value.nonce).padStart(10, "0"), value);
        }
        const value = await signed(good, 11);
        index(selectedStore.store, value);
        index(wrongStore.store, value); // Same visible command and nominal publisher; wrong Store object.
        index(selectedStore.store, await signed(oneSided, 12));
        selectedStore.store.set("local6343PublisherNonce:0000000013", await signed(mirrorOnly, 13));
        async function diskOriginal(attempt: Awaited<ReturnType<typeof signed>>) {
          const step = "10-original-" + attempt.commandId.slice(2), file = join(journal, step + ".original.json");
          await durableJson(file, {runId, step, chainId: 6343, genesisHash, sender: danceScope.publisher,
            to: attempt.target, data: attempt.data, raw: attempt.raw, transactionHash: attempt.hash,
            nonce: attempt.nonce, value: "0", gas: "200000", gasPrice: "1", commandHash: attempt.commandHash});
          return file;
        }
        const file = await diskOriginal(value), loneFile = await diskOriginal(await signed(fileOnly, 14));
        const snapshot = async () => Promise.all([file, loneFile, storePath, wrongPath].map(async path => hash(await readFile(path))));
        selectedStore.close();
        closeSelectedStore = undefined;
        const before = await snapshot();
        const scopedStore = await openPinnedNativeDanceOperatorStore({
          identity: custody.storeIdentity, lease, readOnly: false,
        });
        closeSelectedStore = () => scopedStore.close();
        assert.notEqual(scopedStore.store, selectedStore.store);
        const scopedReader = await createNativeDanceRetainedStore({ ...custody, store: scopedStore.store });
        const otherControl = await acquireWeb2ServiceControl(await mkdtemp(join(root, "other-serve-owner-")), lease.installationId);
        try {
          assert.notEqual(otherControl.lease, lease);
          assert.equal(otherControl.lease.installationId, lease.installationId);
          await lease.assertHeld();
          await otherControl.lease.assertHeld();
          const wrongLeaseRoute = await makePublication(scopedStore.store, scopedReader, otherControl.lease);
          const opensBefore = danceReadyOpens;
          await assert.rejects(wrongLeaseRoute.assertRetainedDanceCustody(danceScope, approvalPin),
            /native_dance_connected_store_lease_changed/);
          assert.equal(danceReadyOpens, opensBefore);
        } finally {
          await otherControl.closeControl();
        }
        const scopedPublication = await makePublication(scopedStore.store, scopedReader);
        await scopedPublication.assertRetainedDanceCustody(danceScope, approvalPin);
        await writeFile(originalIntent, canonical({ ...JSON.parse(composerIntent), localOnly: true }));
        await assert.rejects(scopedPublication.assertRetainedDanceCustody(danceScope, approvalPin), /native_dance_composer_custody_changed/);
        await writeFile(originalIntent, composerIntent);
        await scopedPublication.assertRetainedDanceCustody(danceScope, approvalPin);
        selectedRoute = scopedPublication;
        const initialNonce = scopedStore.store.get("op:nonce");
        function lookup(access = forward) {
          return nativeDanceOriginalTransport(danceScope, access, {
            async fetch(input) {
              const request = new Request(input);
              const response = await send(new URL(request.url).pathname, await request.text(), request.headers.get("authorization")!.slice(7));
              return new Response(response.body || null, {status: response.status, headers: {"content-type":"application/json"}});
            },
          });
        }
        await assert.rejects(lookup(reverse).readRetainedAttempt(good.original), /native_dance/);
        assert.equal(danceReadyOpens, 0);
        const reverseRequest = new Request(app.context.origin + nativeDanceReadyPath, {method:"POST",
          headers:{authorization:"Bearer " + forward, "content-type":"application/json"},
          body: canonical({schema:"pirate.native-dance-retained-reference/1", installationId:danceScope.installationId,
            releaseSha256:danceScope.releaseSha256, original:good.original})});
        assert.equal((await nativeDanceReadyResponse(reverseRequest, reverse, async () => {
          danceReadyOpens++;
          return {db: ports.db, scope: danceScope, assertCurrent: () => installation.check()};
        })).status, 404);
        assert.equal(danceReadyOpens, 0);
        const got = await lookup().readRetainedAttempt(good.original);
        assert(got && digest(got) === digest({nonce:value.nonce,hash:value.hash,raw:value.raw}), "retained bytes changed");
        assert.equal(await lookup().readRetainedAttempt(empty.original), null);
        await assert.rejects(lookup().readRetainedAttempt(oneSided.original), /native_dance/);
        await assert.rejects(lookup().readRetainedAttempt(mirrorOnly.original), /native_dance/);
        await assert.rejects(lookup().readRetainedAttempt(fileOnly.original), /native_dance/);
        await assert.rejects(lookup().readRetainedAttempt({...good.original, commandHash:digest("altered command")}), /native_dance/);
        const opens = danceReadyOpens;
        await assert.rejects(createNativeDanceRetainedStore({ ...custody, store:wrongStore.store }), /native_dance_store_changed/);
        selectedRoute = await makePublication(wrongStore.store);
        const wrong = await send(nativeDanceHostPath, canonical({schema:"pirate.native-dance-retained-reference/1",
          installationId:danceScope.installationId, releaseSha256:danceScope.releaseSha256, original:good.original}));
        assert.equal(wrong.status, 503);
        assert(!wrong.body.includes(value.raw), "wrong Store leaked original");
        assert.equal(danceReadyOpens, opens);
        assert.deepEqual(await snapshot(), before);
        assert.equal(scopedStore.store.get("op:nonce"), initialNonce);
        assert.deepEqual({signs, reads}, {signs:0, reads:0});
        t.diagnostic("two persistent Stores, authenticated Unix/TLS, D1 ready bindings, no journal or chain effects");
        return;
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
