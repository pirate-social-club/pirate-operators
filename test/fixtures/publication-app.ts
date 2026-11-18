// Real HTTP/auth/D1/crypto/Store, with explicit RPC and policy-document servers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, digest } from "../../packages/protocol/index.ts";
import { installFirstPublicationSelection, installPublicationSelection } from "../../services/publication-installed-selection.ts";
import { hashText } from "../../packages/community/common.ts";
import { parsePublicationGrant } from "../../packages/protocol/publication-consent.ts";
import { publicationConsentAbi } from "../../packages/protocol/generated/publication-consent-v1.ts";
import type { PreparedConsentCommandV1 } from "../../packages/protocol/publication-runtime-v1.ts";
import {
  publicationApplicationFetch,
  type PublicationApplicationPorts,
} from "../../services/publication-app.ts";
import {
  PublicationReleaseCatalog,
  publicationSelectionHash,
} from "../../services/publication-app-selection.ts";
import { PublicationOperatorTransport } from "../../services/publication-app-transport.ts";
import { publicationInstalledOperatorFetch } from "../../services/publication-installed-operator.ts";
import { publicationReadRpc } from "../../services/publication-command-rpc.ts";
import { parseCommand } from "../../services/publication-command-contract.ts";
import {
  preparePublicationGrant,
  preparePublicationWithdrawal,
} from "../../packages/protocol/publication-consent.ts";
import { readPublicationJob } from "../../services/publication-command-operator.ts";
import { intentOf, type TxRow } from "../../services/operator-tx.ts";
import { drainPublicationOutbox } from "../../services/publication-app-outbox.ts";
import {
  appDatabase,
  loopback,
  operatorDatabase,
  deferred,
} from "./publication-app-http.ts";
import { scriptedPublicationAuthority } from "./publication-app-rpc.ts";

// Existing public disposable fixture key patterns; never public-chain funds.
export const learner = privateKeyToAccount(`0x${"71".repeat(32)}`),
  other = privateKeyToAccount(`0x${"72".repeat(32)}`),
  payer = privateKeyToAccount(`0x${"73".repeat(32)}`),
  issuer = privateKeyToAccount(`0x${"74".repeat(32)}`);
const lower = (a: Address) => a.toLowerCase() as Address;
const q = (n: bigint) => ("0x" + n.toString(16)) as Hex;
export async function publicationAppFixture(
  t: TestContext,
  options: {
    firstSong?: boolean;
    safeLag?: bigint;
    window?: string;
    installSelection?: boolean;
    trustedFirstSelection?: boolean;
  } = {},
) {
  const database = await appDatabase(),
    directory = await mkdtemp(join(tmpdir(), "publication-http-"));
  let nowMs = Math.floor(Date.now() / 1000) * 1000;
  let operator = operatorDatabase(
    join(directory, "operator.sqlite"),
    Math.floor(nowMs / 1000),
  );
  let rpc: Awaited<ReturnType<typeof loopback>> | undefined,
    opHttp: typeof rpc,
    app: typeof rpc;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app?.close();
    await opHttp?.close();
    await rpc?.close();
    operator.close();
    await database.runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  let authority: ReturnType<typeof scriptedPublicationAuthority>;
  rpc = await loopback((request) => authority.handle(request));
  authority = scriptedPublicationAuthority(
    rpc.origin,
    BigInt(Math.floor(nowMs / 1000)) - (options.safeLag ?? 0n),
    { issuer: lower(issuer.address), operator: lower(payer.address) },
  );
  if (options.window) authority.release.submitWindowSeconds = options.window;
  if (options.trustedFirstSelection) {
    assert(!options.firstSong && options.installSelection !== false);
    authority.release.policies = {
      "dance-verdict": authority.release.policies["dance-verdict"]!,
      "dance-review-attribution": authority.release.policies["dance-review-attribution"]!,
    };
  }
  const selected = publicationSelectionHash(authority.release);
  let catalog = new PublicationReleaseCatalog(
    [authority.release],
    options.firstSong ? null : selected,
  );
  const context = {
    communityId: authority.release.source.communityId,
    origin: authority.release.configuration.app.origin,
  };
  const cookie = "a".repeat(64),
    csrf = "fixture-csrf-value",
    sessionHash = hashText(cookie);
  await database.native.batch([
    database.native
      .prepare("INSERT INTO application_identity VALUES(1,?,?)")
      .bind(context.communityId, context.origin),
    database.native
      .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
      .bind("account", digest("author"), nowMs),
    database.native
      .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
      .bind("binding", "account", "moss", 6343, lower(learner.address), nowMs),
    database.native
      .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
      .bind(
        sessionHash,
        context.communityId,
        context.origin,
        "account",
        "binding",
        csrf,
        Date.now() + 3600000,
      ),
  ]);
  let losePath: string | null = null;
  let heldOperator: {
    path: string;
    entered: ReturnType<typeof deferred>;
    gate: ReturnType<typeof deferred>;
  } | null = null;
  let heldOperatorResult: {
    path: string;
    entered: ReturnType<typeof deferred>;
    gate: ReturnType<typeof deferred>;
  } | null = null;
  const operatorCalls: { path: string; bodySha256: Hex }[] = [];
  const operatorErrors: { path: string; error: string }[] = [];
  const read = publicationReadRpc(
    rpc.origin + "/rpc",
    controller.signal,
    131072,
  );
  opHttp = await loopback(async (request) => {
    const path = new URL(request.url).pathname;
    operatorCalls.push({
      path,
      bodySha256: hashText(await request.clone().text()),
    });
    if (heldOperator?.path === path) {
      const held = heldOperator;
      heldOperator = null;
      held.entered.resolve();
      await held.gate.promise;
    }
    let response: Response | null;
    try {
      response = await publicationInstalledOperatorFetch(request, {
        catalog,
        operatorAddress: lower(payer.address),
        store: operator.store,
        read,
        clock: () => Math.floor(nowMs / 1000),
      });
    } catch (error) {
      operatorErrors.push({
        path,
        error:
          error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
            ? error.message
            : "fixture_operator_error",
      });
      throw error;
    }
    assert.ok(response);
    if (heldOperatorResult?.path === path) {
      const held = heldOperatorResult;
      heldOperatorResult = null;
      held.entered.resolve();
      await held.gate.promise;
    }
    if (losePath === path) {
      losePath = null;
      throw Error("explicit lost response after actual operator commit");
    }
    return response;
  }, "https://publication.internal");
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init),
        url = new URL(request.url);
      return fetch(opHttp!.origin + url.pathname, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
        signal: request.signal,
        redirect: "error",
      });
    },
  } as unknown as Pick<Fetcher, "fetch">;
  const transport = new PublicationOperatorTransport(
    fetcher,
    {
      address: lower(issuer.address),
      signMessage: (input) => issuer.signMessage(input),
    },
    () => Math.floor(nowMs / 1000),
    3000,
    32768,
  );
  let installationEntries = [
    { release: catalog.get(selected), transportRef: "operator-primary" },
  ];
  const selection = {
    schema: "pirate.publication-installation/1" as const,
    communityId: context.communityId,
    installationId: authority.release.source.installationId,
    origin: context.origin,
    incarnation: "1",
    installedBindingSha256: digest("installed-binding-1"),
    active: options.firstSong ? null : selected,
    entries: installationEntries,
    previous: null,
  };
  const installation = options.installSelection === false ? undefined :
    options.trustedFirstSelection ? await installFirstPublicationSelection(database.db, selection, Date.now() + 60000) :
    await installPublicationSelection(database.db, selection);
  if (installation) catalog = installation.catalog;
  let ports: PublicationApplicationPorts = {
    db: database.db,
    installation,
    catalog,
    transport,
    nowMs: () => nowMs,
    retryDelayMs: 100,
    observationDelayMs: 200,
    client: createPublicClient({
      cacheTime: 0,
      transport: http(rpc.origin + "/rpc", { retryCount: 0, timeout: 3000 }),
    }),
    clock: {
      now: () => BigInt(Math.floor(nowMs / 1000)),
      maxSafeBlockAgeSeconds: 900n,
    },
    documentTimeoutMs: 3000,
    maxDocumentBytes: 65536,
  };
  app = await loopback(async (request) => {
    const response = await publicationApplicationFetch(request, ports, context);
    return response ?? new Response("missing", { status: 404 });
  }, context.origin);
  const httpResponses: { route: string; status: number; error: unknown }[] = [];
  const sourceIds = new Map<string, Hex>();
  const call = async (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(
      app!.origin + "/api/publication-consent/v1/" + route,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: "__Host-community_session=" + cookie,
          origin: context.origin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const value = (await response.json()) as Record<string, unknown>;
    if (
      typeof value.commandId === "string" &&
      typeof value.sourceId === "string" &&
      /^0x[0-9a-f]{64}$/.test(value.sourceId)
    )
      sourceIds.set(value.commandId, value.sourceId as Hex);
    httpResponses.push({
      route,
      status: response.status,
      error: value.error ?? null,
    });
    return { status: response.status, value };
  };
  // Client metadata comes only from the real HTTP response, never from D1.
  const withdrawal = (
    route: string,
    input: {
      purpose: string;
      requestId: string;
      sourceCommandId: Hex;
      action?: string;
    },
  ) => {
    const sourceId = sourceIds.get(input.sourceCommandId);
    assert.ok(sourceId, "client must retain the returned source ID");
    return call(route, {
      purpose: input.purpose,
      requestId: input.requestId,
      sourceId,
    });
  };
  const rows = async () =>
    (
      await database.native
        .prepare("SELECT * FROM publication_v1_commands ORDER BY command_id")
        .all<import("../../services/publication-command-store.ts").CommandRow>()
    ).results;
  return {
    get ports() {
      return ports;
    },
    context,
    authority,
    operatorCalls,
    operatorErrors,
    db: database.native,
    holdMutation: database.holdMutation,
    failRead: database.failRead,
    call,
    rows,
    now: () => BigInt(Math.floor(nowMs / 1000)),
    advance(seconds: bigint) {
      nowMs += Number(seconds * 1000n);
    },
    submit: (input: { commandId: Hex; signature: Hex }) =>
      call("commands/" + input.commandId + "/submit", {
        signature: input.signature,
      }),
    stop: (input: {
      purpose: string;
      requestId: string;
      sourceCommandId: Hex;
      action?: string;
    }) => withdrawal("withdrawals/stop", input),
    withdraw: (input: {
      purpose: string;
      requestId: string;
      sourceCommandId: Hex;
      action?: string;
    }) => withdrawal("withdrawals/prepare", input),
    async setCatalog(active: Hex | null) {
      assert.ok(ports.installation);
      const next = await installPublicationSelection(database.db, {
        schema: "pirate.publication-installation/1",
        ...context,
        installationId: ports.installation.expected.installationId,
        incarnation: String(
          Number(ports.installation.expected.incarnation) + 1,
        ),
        installedBindingSha256: digest({
          active,
          previous: ports.installation.expected,
        }),
        active,
        entries: installationEntries,
        previous: ports.installation.expected,
      });
      catalog = next.catalog;
      ports = { ...ports, catalog, installation: next };
    },
    async replaceActive(
      release: import("../../services/publication-app-selection.ts").PublicationAppRelease,
    ) {
      assert.ok(ports.installation);
      const entries = [
        ...installationEntries,
        { release, transportRef: "operator-primary" },
      ];
      const next = await installPublicationSelection(database.db, {
        schema: "pirate.publication-installation/1",
        ...context,
        installationId: release.source.installationId,
        incarnation: String(
          Number(ports.installation.expected.incarnation) + 1,
        ),
        installedBindingSha256: digest({
          release,
          previous: ports.installation.expected,
        }),
        active: publicationSelectionHash(release),
        entries,
        previous: ports.installation.expected,
      });
      installationEntries = structuredClone(entries);
      catalog = next.catalog;
      ports = { ...ports, catalog, installation: next };
    },
    restartOperator() {
      operator.close();
      operator = operatorDatabase(
        join(directory, "operator.sqlite"),
        Math.floor(nowMs / 1000),
      );
    },
    store: () => operator.store,
    loseOperatorResponse(path: string) {
      losePath = path;
    },
    holdOperator(path: string) {
      assert.equal(heldOperator, null);
      const entered = deferred(),
        gate = deferred();
      heldOperator = { path, entered, gate };
      return { entered: entered.promise, release: gate.resolve };
    },
    holdOperatorResult(path: string) {
      assert.equal(heldOperatorResult, null);
      const entered = deferred(),
        gate = deferred();
      heldOperatorResult = { path, entered, gate };
      return { entered: entered.promise, release: gate.resolve };
    },
    drain: () =>
      drainPublicationOutbox(ports, { maxCommands: 20, maxDurationMs: 10000 }),
    revokeSession: () =>
      database.native
        .prepare("DELETE FROM community_sessions WHERE session_hash=?")
        .bind(sessionHash)
        .run(),
    async prepare(requestId = "grant-1", purpose = "study-results") {
      return call("grants/prepare", { purpose, requestId });
    },
    async sign(command: unknown, actor = learner) {
      const c = parseCommand(command);
      if (c.action === "grant")
        return actor.signTypedData(
          preparePublicationGrant(31337n, c.source.registry, c.message, "0x")
            .typed,
        );
      return actor.signTypedData(
        preparePublicationWithdrawal(31337n, c.source.registry, c.message, "0x")
          .typed,
      );
    },
    /** Historical original fixture, not a production sender: one signed raw
     * allocation is put in the existing nonce journal and RPC wire ledger. */
    async historicalRecordedOriginal(command: PreparedConsentCommandV1) {
      assert.equal(command.action, "grant");
      const job = readPublicationJob(operator.store, command.commandId);
      assert.ok(job);
      const intent = intentOf(operator.store, job.kind, job.ref);
      assert.ok(intent);
      const nonce = operator.store.get<number>("op:nonce") ?? 0;
      const key = "tx:" + String(nonce).padStart(10, "0");
      const raw = await payer.signTransaction({
          type: "legacy",
          chainId: 31337,
          nonce,
          to: command.source.registry,
          data: job.data,
          value: 0n,
          gas: BigInt(job.fee.gas),
          gasPrice: BigInt(job.fee.gasPrice),
        }),
        hash = keccak256(raw);
      operator.store.transaction(() => {
        operator.store.set(`intent:${job.kind}:${job.ref}`, {
          ...intent,
          nonce,
        });
        operator.store.set(key, {
          nonce,
          kind: job.kind,
          ref: job.ref,
          chainId: 31337,
          to: command.source.registry,
          data: job.data,
          gas: job.fee.gas,
          gasPrice: job.fee.gasPrice,
          raw,
          hash,
          broadcast: "attempted",
          mined: null,
          publicationV1: job.fee,
        } satisfies TxRow);
        operator.store.set("op:nonce", nonce + 1);
      });
      const number = authority.state.safe.number - 1n,
        blockHash = digest({ historicalOriginalNonce: nonce }),
        timestamp = authority.state.safe.timestamp,
        g = parsePublicationGrant(command.message),
        event = publicationConsentAbi.find(
          (e) => e.type === "event" && e.name === "PublicationGranted",
        )!;
      authority.state.grant = command.message;
      authority.state.recordedAt = timestamp;
      authority.state.blocks.set(
        number,
        authority.block(number, blockHash, timestamp, [hash]),
      );
      authority.state.transactions.set(hash, {
        hash,
        from: lower(payer.address),
        to: command.source.registry,
        input: job.data,
        nonce: q(BigInt(nonce)),
        value: "0x0",
        blockHash,
        blockNumber: q(number),
        transactionIndex: "0x0",
      });
      authority.state.receipts.set(hash, {
        transactionHash: hash,
        from: lower(payer.address),
        to: command.source.registry,
        blockHash,
        blockNumber: q(number),
        transactionIndex: "0x0",
        status: "0x1",
        logs: [
          {
            address: command.source.registry,
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash,
            blockNumber: q(number),
            topics: encodeEventTopics({
              abi: publicationConsentAbi,
              eventName: "PublicationGranted",
              args: {
                grantId: command.digest,
                learner: g.learner,
                purposeHash: keccak256(new TextEncoder().encode(g.purpose)),
              },
            }),
            data: encodeAbiParameters(
              event.inputs.filter((i) => !i.indexed),
              [g, timestamp],
            ),
          },
        ],
      });
      return { raw, hash, nonce };
    },
    async artifact(label: string) {
      const values = (await rows()).map((r) => ({
        commandId: r.command_id,
        requestHash: r.request_hash,
        nonce: r.nonce_hex,
        phase: r.phase,
        digest: r.digest,
        acceptedSha256: r.accepted_json ? hashText(r.accepted_json) : null,
        fenceGeneration: r.fence_generation,
        fenceAck: r.fence_ack_json,
        result: r.result_state,
      }));
      const value = {
        schema: "pirate.publication-app-integration/1",
        label,
        boundaries: "real HTTP/auth/D1/crypto/Store; scripted RPC",
        commands: values,
        heads: (
          await database.native
            .prepare(
              "SELECT source_id,purpose,generation,stopped FROM publication_v1_heads",
            )
            .all()
        ).results,
        operatorNonce: operator.store.get("op:nonce") ?? null,
        intents: operator.store.entries("intent:").length,
        operatorCalls,
        operatorErrors,
        rpcMethods: authority.state.calls,
        httpResponses,
      };
      const path = ".local/publication-app-integration/" + label + ".json";
      await mkdir(".local/publication-app-integration", { recursive: true });
      const bytes = JSON.stringify(value, null, 2) + "\n";
      await writeFile(path, bytes);
      t.diagnostic(JSON.stringify({ artifact: path, sha256: hashText(bytes) }));
      return value;
    },
  };
}
