// Disposable real Anvil + D1; public fixture keys never leave this local chain.
import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { object } from "../../packages/community/common.ts";
import { ownedManagedPackageDependencies } from "./managed-package-dependencies.ts";
import { hostedCommunityPackage, writeHostedCommunityPackage } from "../../harness/managed-package.ts";
import assert from "node:assert/strict";
import solc from "solc";
import { CoreHeaders, Miniflare, Response as MiniflareResponse } from "miniflare";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  canonical,
  hashText,
  publicId,
  token,
} from "../../packages/community/common.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import {
  directoryV3Abi,
  directoryV3Build,
  validateWeb2Profile,
  web2ProfileDocument,
} from "../../packages/community/web2-directory.ts";
import { directoryInstanceId } from "../../packages/community/shared-identity.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import {
  enrollmentTypedData,
  type HostedPolicy,
} from "../../packages/community/hosted-enrollment.ts";
import {
  loadEnrollment,
  provisionHostedInvite,
} from "../../packages/community/hosted-enrollment-store.ts";
import {
  type HostedRuntime,
  type HostedSigner,
} from "../../packages/community/hosted-topup-chain.ts";
import { createHostedEnrollmentService } from "../../services/hosted-community-enrollment.ts";
import { createHostedFundingService } from "../../services/hosted-community-funding.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";
import {
  installationReadbackMessage,
  installationReadbackTypedData,
} from "../../packages/community/web2-installation-readback.ts";

const fixtureAccounts = Array.from({ length: 6 }, (_, i) =>
  privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}`),
);
export const zero = "0x0000000000000000000000000000000000000000";
export const lower = (a: Address) => a.toLowerCase() as Address;
let artifacts:
  | Record<string, { abi: Abi; bytecode: Hex; runtime: Hex }>
  | undefined;
function compile() {
  if (artifacts) return artifacts;
  const files = [
    "contracts/community/CommunityDirectoryV3.sol",
    "contracts/community/PublicationReference.sol",
    "contracts/community/CommunityPostsV1.sol",
    "contracts/interfaces/community/ICommunityPostsV1.sol",
    "contracts/interfaces/community/ICommunityDirectoryV1.sol",
    "contracts/interfaces/community/ICommunityDirectoryV3.sol",
    "contracts/test/MockAccount.sol",
  ];
  const sources = Object.fromEntries(
    files.map((f) => [f, { content: readFileSync(f, "utf8") }]),
  );
  assert.match(solc.version(), /^0\.8\.30\+commit\.73712a01/);
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          metadata: { bytecodeHash: "ipfs" },
          outputSelection: {
            "*": {
              "*": [
                "abi",
                "evm.bytecode.object",
                "evm.deployedBytecode.object",
              ],
            },
          },
        },
      }),
    ),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<
        string,
        {
          abi: Abi;
          evm: {
            bytecode: { object: string };
            deployedBytecode: { object: string };
          };
        }
      >
    >;
  };
  assert.deepEqual(
    output.errors?.filter((x) => x.severity === "error") ?? [],
    [],
  );
  artifacts = Object.fromEntries(
    Object.values(output.contracts).flatMap((c) =>
      Object.entries(c).map(([name, a]) => [
        name,
        {
          abi: a.abi,
          bytecode: `0x${a.evm.bytecode.object}` as Hex,
          runtime: `0x${a.evm.deployedBytecode.object}` as Hex,
        },
      ]),
    ),
  );
  assert.equal(
    keccak256(artifacts.CommunityDirectoryV3!.runtime),
    directoryV3Build.runtimeCodeHash,
  );
  return artifacts;
}
export async function hostedFixture(overrides: Partial<HostedPolicy> = {}, options: { packaged?: boolean; chainId?: 31337 | 6343 } = {}) {
  const chainId = options.chainId ?? 31337,
    fixtureChain = { ...foundry, id: chainId };
  const compiled = compile(),
    portReservation = createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const portAddress = portReservation.address();
  assert(portAddress && typeof portAddress !== "string");
  const port = portAddress.port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  const child = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--timestamp",
      String(options.packaged || chainId === 6343 ? Math.floor(Date.now() / 1000) - 30 : 1800000000),
      "--slots-in-an-epoch",
      "1",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const url = `http://127.0.0.1:${port}`,
    rpc = async (method: string, params: unknown[] = []) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const result = (await response.json()) as {
        result: unknown;
        error?: unknown;
      };
      if (result.error) throw Error(JSON.stringify(result.error));
      return result.result;
    };
  const local = createPublicClient({
    transport: http(url, { retryCount: 0 }),
    chain: fixtureChain,
  });
  const journal = options.packaged ? await mkdtemp(join(tmpdir(), "hosted-worker-journal-")) : undefined;
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('unused fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: { DB: "hosted-fixture" },
    ...(journal ? { d1Persist: journal } : {}),
  });
  const pins = new Map<string, Uint8Array>(),
    installations = new Map<string, { config: Web2CommunityConfig; publisherAccount: (typeof fixtureAccounts)[number] }>(),
    state = {
      dropSend: 0,
      dropBeforeSend: 0,
      sendCount: 0,
      clock: options.packaged || chainId === 6343 ? Math.floor(Date.now() / 1000) : 1800000030,
      invalidPin: false,
      redirectPin: false,
      installationStatus: 200,
      installationMismatch: false,
      installationProofInvalid: false,
      readInstallation: undefined as typeof fetch | undefined,
      registrarSignatures: 0,
      funderSignatures: 0,
      failRpc: false,
      beforeSend: undefined as (() => Promise<void>) | undefined,
    };
  // A real HTTP transport proxy may lose a response only after the actual RPC
  // processed it. It does not fabricate chain methods or successful receipts.
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    if (req.url?.startsWith("/ipfs/")) {
      if (state.redirectPin) { res.writeHead(302, { location: "https://not-selected.invalid/config" }); res.end(); return; }
      const bytes = pins.get(`ipfs://${req.url.slice(6)}`);
      res.writeHead(bytes ? 200 : 404);
      res.end(state.invalidPin ? "changed" : bytes);
      return;
    }
    if (state.failRpc) {
      res.writeHead(503);
      res.end("fixture RPC unavailable");
      return;
    }
    const body = Buffer.concat(chunks),
      parsed = JSON.parse(body.toString()) as { method?: string };
    if (
      parsed.method === "eth_sendRawTransaction" &&
      state.dropBeforeSend > 0
    ) {
      state.dropBeforeSend--;
      res.destroy();
      return;
    }
    if (parsed.method === "eth_sendRawTransaction" && state.beforeSend) {
      const before = state.beforeSend;
      state.beforeSend = undefined;
      await before();
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    if (parsed.method === "eth_sendRawTransaction") {
      state.sendCount++;
      if (state.dropSend > 0) {
        state.dropSend--;
        res.destroy();
        return;
      }
    }
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(text);
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(errors);
      try {
        await local.getChainId();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert(ready, "anvil readiness");
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    assert(proxyAddress && typeof proxyAddress !== "string");
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    const client = createPublicClient({
      transport: http(proxyUrl, { retryCount: 0 }),
      chain: foundry,
    });
    const [admin, registrar, funder, controller, publisher, stranger] =
      fixtureAccounts as [
        (typeof fixtureAccounts)[number],
        (typeof fixtureAccounts)[number],
        (typeof fixtureAccounts)[number],
        (typeof fixtureAccounts)[number],
        (typeof fixtureAccounts)[number],
        (typeof fixtureAccounts)[number],
      ];
    for (const a of fixtureAccounts)
      await rpc("anvil_setBalance", [a.address, "0x3635c9adc5dea00000"]);
    const wallet = createWalletClient({
      account: admin,
      transport: http(url, { retryCount: 0 }),
      chain: fixtureChain,
    });
    const hash = await wallet.deployContract({
      abi: compiled.CommunityDirectoryV3!.abi,
      bytecode: compiled.CommunityDirectoryV3!.bytecode,
      args: [admin.address],
    });
    const receipt = await local.waitForTransactionReceipt({ hash });
    assert(receipt.contractAddress);
    const directory = lower(receipt.contractAddress);
    const postsHash = await wallet.deployContract({
      abi: compiled.CommunityPostsV1!.abi,
      bytecode: compiled.CommunityPostsV1!.bytecode,
      args: [directory],
    });
    const postsReceipt = await local.waitForTransactionReceipt({ hash: postsHash });
    assert(postsReceipt.contractAddress);
    const posts = {
      address: lower(postsReceipt.contractAddress),
      runtimeCodeHash: keccak256((await local.getCode({ address: postsReceipt.contractAddress, blockNumber: postsReceipt.blockNumber }))!),
      deploymentBlock: String(postsReceipt.blockNumber),
    };
    const configure = await wallet.writeContract({
      address: directory,
      abi: directoryV3Abi,
      functionName: "configureRegistrar",
      args: [registrar.address, 1800086400n, 100n, 0n],
    });
    await local.waitForTransactionReceipt({ hash: configure });
    const mine = async () => {
      await rpc("anvil_mine", ["0x4"]);
      state.clock = Number((await local.getBlock()).timestamp) + 30;
    };
    await mine();
    let db = await mf.getD1Database("DB");
    const sql = readFileSync(
        "packages/community/schema/hosted-enrollment.sql",
        "utf8",
      );
    if (!options.packaged) await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    const policy: HostedPolicy = {
      schema: "pirate.hosted-enrollment-policy/1",
      pilotId: "fixture",
      serviceOrigin: "https://hosted.example",
      deployment: {
        schema: "pirate.web2-directory/3",
        chainId,
        directory,
        directoryCodeHash: directoryV3Build.runtimeCodeHash,
        directoryAbiSha256: directoryV3Build.abiSha256,
        sourceCommit: "c6c98cbce4fbc23f4d18a6209f84d2429822bdf4",
        deploymentBlock: receipt.blockNumber,
      },
      registrar: lower(registrar.address),
      funder: lower(funder.address),
      registrarRevision: "1",
      noticeSha256: hashText(
        "Disposable pilot: no backup or production availability guarantee",
      ),
      inviteMaxSeconds: 3600,
      challengeSeconds: 1800,
      maxSafeBlockAgeSeconds: 300,
      broadcastRetrySeconds: 10,
      maxBroadcastAttempts: 3,
      registrationGas: "1500000",
      topupGas: "50000",
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "1000000000",
      extraFeeCeiling: "0",
      extraFeeField: "none",
      globalCeiling: "1000000000000000000",
      communityCeiling: "500000000000000000",
      recipientCeiling: "500000000000000000",
      controllerInitialWei: "10000000000000000",
      publisherInitialWei: "20000000000000000",
      ...overrides,
    };
    const evidenceDirectory = await mkdtemp(join(process.env.MANAGED_SERVICES_EVIDENCE_DIRECTORY ?? tmpdir(), "hosted-fixture-"));
    const evidence = async (label: string, value: unknown) => writeFile(join(evidenceDirectory, label + ".json"), JSON.stringify(value, null, 2), { mode: 0o600 });
    const packageInput = { identity: { prefix: "pirate-hosted-local-fixture", packageProfile: "hosted-enrollment" as const, planId: publicId(),
      state: { store: "pirate-encrypted-local" as const, stack: "pirate-hosted-local-fixture" } }, policy, rpcUrl: proxyUrl + "/", configurationGateway: proxyUrl + "/ipfs/" };
    const pkg = options.packaged ? await hostedCommunityPackage(packageInput, await ownedManagedPackageDependencies()) : undefined;
    const packageDirectory = pkg ? await mkdtemp(join(tmpdir(), "hosted-worker-package-")) : undefined;
    const cwd = pkg ? await writeHostedCommunityPackage(packageDirectory!, pkg) : undefined;
    const repeatMigrations = async () => {
      assert(cwd);
      const wizard = createRequire(join(cwd, "package.json")), cloud = createRequire(wizard.resolve("@alchemy.run/cloudflare/D1/Database")),
        E = await import(pathToFileURL(wizard.resolve("effect/Effect")).href), N = await import(pathToFileURL(wizard.resolve("@effect/platform-node/NodeServices")).href),
        M = await import(pathToFileURL(cloud.resolve("@alchemy.run/sql/Migrations")).href), S = await import(pathToFileURL(cloud.resolve("@alchemy.run/sql/SqlFile")).href),
        A = await import(pathToFileURL(wizard.resolve("@alchemy.run/cloudflare/D1/ApplyMigrations")).href);
      const executor = A.makeD1MigrationExecutor((query: string) => E.tryPromise(async () => ({ result: await db.batch(S.splitSqliteStatements(query).map((statement: string) => db.prepare(statement))) })));
      return E.runPromise(M.runMigrations({ input: { dir: join(cwd, "migrations") }, stamped: {}, withExecutor: (apply: (e: typeof executor) => ReturnType<typeof E.succeed>) => apply(executor) }).pipe(E.provide(N.layer)));
    };
    if (pkg) {
      await repeatMigrations();
      await evidence("installed-migrator", { journal, packageDirectory, profileHash: pkg.profileHash, bundleSha256: pkg.profile.bundleSha256,
        metadata: (await db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all()).results,
        ledger: (await db.prepare("SELECT * FROM __alchemy_migrations ORDER BY id").all()).results });
    }
    const workerBindings = pkg ? { HOSTED_COMMUNITY_PROFILE: "hosted-enrollment", HOSTED_COMMUNITY_CONFIGURATION_JSON: canonical(pkg.profile.configuration),
      HOSTED_COMMUNITY_CONFIGURATION_SHA256: hashText(canonical(pkg.profile.configuration)),
      HOSTED_REGISTRAR_PRIVATE_KEY: "0x" + "2".padStart(64, "0"), HOSTED_FUNDER_PRIVATE_KEY: "0x" + "3".padStart(64, "0") } : undefined;
    let configurationOverride: Record<string, string> = {};
    const restart = async (keys?: { registrar?: Hex | null; funder?: Hex | null }) => {
      assert(pkg && cwd && workerBindings && journal);
      const bindings: Record<string, string> = { ...workerBindings, ...configurationOverride };
      if (keys?.registrar === null) delete bindings.HOSTED_REGISTRAR_PRIVATE_KEY;
      else if (keys?.registrar) bindings.HOSTED_REGISTRAR_PRIVATE_KEY = keys.registrar;
      if (keys?.funder === null) delete bindings.HOSTED_FUNDER_PRIVATE_KEY;
      else if (keys?.funder) bindings.HOSTED_FUNDER_PRIVATE_KEY = keys.funder;
      await mf.setOptions({ modules: true, script: await readFile(join(cwd, "worker/worker.mjs"), "utf8"),
        compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "hosted-fixture" }, d1Persist: journal,
        bindings, outboundService: async (request: import("miniflare").Request) => {
          const url = new URL(request.url); assert.equal(url.origin, proxyUrl, "only exact disposable fixture transport");
          const response = await fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
            body: request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer()), redirect: "error" });
          return new MiniflareResponse(new Uint8Array(await response.arrayBuffer()), { status: response.status, headers: Object.fromEntries(response.headers) });
        } });
      db = await mf.getD1Database("DB");
    };
    if (pkg) await restart();
    const requestWorker = async (path: string, init?: RequestInit) => {
      const request = new Request(policy.serviceOrigin + path, init), target = new URL(request.url), local = await mf.ready,
        headers = Object.fromEntries(request.headers);
      headers.host ??= target.host; headers[CoreHeaders.ORIGINAL_URL] = request.url; headers[CoreHeaders.DISABLE_PRETTY_ERROR] = "true";
      const body = new Uint8Array(await request.arrayBuffer());
      return new Promise<Response>((resolveResponse, reject) => {
        const outgoing = httpRequest({ agent: false, hostname: local.hostname, port: local.port, method: request.method, path: target.pathname + target.search, headers }, incoming => {
          const chunks: Buffer[] = []; let size = 0;
          incoming.on("data", chunk => { size += chunk.length; if (size > 256 * 1024) incoming.destroy(Error("hosted_fixture_response_limit")); else chunks.push(chunk); });
          incoming.on("error", reject); incoming.on("end", () => {
            assert(incoming.statusCode); const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
            resolveResponse(new Response(Uint8Array.from(Buffer.concat(chunks)), { status: incoming.statusCode, headers: responseHeaders }));
          });
        }); outgoing.on("error", reject); outgoing.end(body);
      });
    };
    const collectProfile = async (keys: boolean, selection = "valid") => {
      assert(pkg && cwd);
      const script = join(cwd, "collect-hosted-profile.mjs");
      await writeFile(script, `import {existsSync} from "node:fs";
import * as E from "effect/Effect"; import * as C from "effect/ConfigProvider"; import * as R from "effect/Redacted";
import {StackContext} from "alchemy/StackContext";
const module=await import("./alchemy.run.ts");
const stack={name:module.default.stackName,stage:"local-hosted",resources:{},bindings:{},actions:{}};
const inputs=JSON.parse(process.env.FIXTURE_ROLE_CONFIG);
await E.runPromise(module.selectedManagedResources.pipe(E.provideService(StackContext,stack),E.provideService(C.ConfigProvider,C.fromUnknown(inputs))));
console.log(JSON.stringify({stack:stack.name,resources:Object.values(stack.resources).map(resource=>({type:resource.Type,
secretNames:Object.entries(resource.Props.env??{}).filter(([key,value])=>R.isRedacted(value)).map(([key])=>key).sort(),
crons:resource.Props.crons??[],assets:resource.Props.assets??null,migrations:resource.Props.migrations??null,date:resource.Props.compatibility?.date??null})),stateCreated:existsSync(".alchemy")}));`, { mode: 0o600 });
      const roleConfig = keys ? { HOSTED_REGISTRAR_PRIVATE_KEY: "explicit-local-config-fixture-registrar", HOSTED_FUNDER_PRIVATE_KEY: "explicit-local-config-fixture-funder" } : {};
      const env: Record<string, string> = { PATH: process.env.PATH!, TMPDIR: tmpdir(), FIXTURE_ROLE_CONFIG: JSON.stringify(roleConfig),
        MANAGED_SERVICE_PACKAGE_PROFILE: selection === "valid" || selection === "wrong-plan" || selection === "wrong-digest" ? "hosted-enrollment" : selection,
        MANAGED_WEB2_PREFIX: pkg.profile.prefix, MANAGED_WEB2_PLAN_ID: selection === "wrong-plan" ? publicId() : pkg.profile.identity.planId,
        MANAGED_WEB2_PACKAGE_DIGEST: selection === "wrong-digest" ? publicId() : hashText(canonical(pkg.profile)) };
      if (selection === "missing") delete env.MANAGED_SERVICE_PACKAGE_PROFILE;
      let stdout = "", stderr = "", exit = 0;
      try { const result = await promisify(execFile)(process.execPath, [script], { cwd, env, timeout: 60000, maxBuffer: 1024 * 1024 }); stdout = result.stdout; stderr = result.stderr; }
      catch (error) { assert(error instanceof Error && "stdout" in error && "stderr" in error && "code" in error); stdout = String(error.stdout); stderr = String(error.stderr); assert.equal(typeof error.code, "number"); exit = Number(error.code); }
      const stateCreated = await import("node:fs").then(fs => fs.existsSync(join(cwd, ".alchemy")));
      if (exit !== 0) return { exit, stateCreated, stack: "", resources: [], refusal: stderr };
      const result = object(JSON.parse(stdout)); assert.equal(typeof result.stack, "string"); assert(Array.isArray(result.resources));
      const resources = result.resources.map(value => { const row = object(value);
        assert.equal(typeof row.type, "string"); assert(Array.isArray(row.secretNames) && row.secretNames.every(v => typeof v === "string"));
        assert(Array.isArray(row.crons)); assert(row.migrations === null || typeof row.migrations === "string"); assert(row.date === null || typeof row.date === "string");
        return { type: row.type, secretNames: row.secretNames, crons: row.crons, assets: row.assets, migrations: row.migrations, date: row.date }; });
      return { exit, stateCreated, stack: result.stack, resources };
    };
    const configurationFault = async (fault: string, action: () => Promise<void>) => {
      assert(pkg && workerBindings);
      const config = JSON.parse(canonical(pkg.profile.configuration));
      if (fault === "missing-context") delete config.schemaContext;
      if (fault === "ledger-context") config.schemaContext.migrations[0].hash = "00".repeat(32);
      if (fault === "rpc-origin") config.rpcUrl = "http://not-selected.invalid/";
      const bytes = canonical(config);
      configurationOverride = { HOSTED_COMMUNITY_PROFILE: fault === "profile" ? "other" : "hosted-enrollment",
        HOSTED_COMMUNITY_CONFIGURATION_JSON: bytes, HOSTED_COMMUNITY_CONFIGURATION_SHA256: fault === "configuration-pin" ? publicId() : hashText(bytes) };
      await restart(); try { await action(); } finally { configurationOverride = {}; await restart(); }
    };
    const worker = pkg && cwd ? { context: pkg.profile.configuration.schemaContext, pkg, cwd, restart, repeatMigrations, collectProfile, configurationFault, request: requestWorker, evidence } : undefined;
    const signer = (a: typeof admin): HostedSigner => ({
      address: lower(a.address),
      signTransaction: async (tx) => {
        if (a === registrar) state.registrarSignatures++;
        if (a === funder) state.funderSignatures++;
        return a.signTransaction(tx);
      },
    });
    const runtime: HostedRuntime = {
      db,
      policy,
      ...(pkg ? { schemaContext: pkg.profile.configuration.schemaContext } : {}),
      client,
      now: () => state.clock,
      registrar: signer(registrar),
      funder: signer(funder),
      readConfiguration: async (uri) =>
        fetch(`${proxyUrl}/ipfs/${uri.slice(7)}`),
      readInstallation: async (url, init) => {
        if (state.readInstallation) return state.readInstallation(url, init);
        const requestUrl = new URL(String(url)),
          id = requestUrl.searchParams.get("communityId");
        const installed = id ? installations.get(id as `0x${string}`) : undefined;
        if (!installed || state.installationStatus !== 200)
          return Response.json({ error: "installation unavailable" }, { status: state.installationStatus, headers: { "cache-control": "no-store" } });
        const config = state.installationMismatch
          ? { ...installed.config, app: { ...installed.config.app, label: "substituted" } }
          : installed.config;
        const message = installationReadbackMessage({
          enrollmentId: requestUrl.searchParams.get("enrollmentId") as Hex,
          config,
          nonce: requestUrl.searchParams.get("nonce") as Hex,
          installation: {
              generation: 1,
              planId: "web2-" + (requestUrl.searchParams.get("enrollmentId") as Hex).slice(2),
              durableScope: "a".repeat(64),
              releaseArtifactDigest: ("0x" + "b".repeat(64)) as Hex,
              releaseSourceDigest: ("0x" + "c".repeat(64)) as Hex,
              targetDigest: "d".repeat(64),
              hostFingerprint: "fixture-installation",
            },
        });
        const signature = await (state.installationProofInvalid ? stranger : installed.publisherAccount).signTypedData(
          installationReadbackTypedData(config, message),
        );
        return Response.json(
          {
            schema: "pirate.web2-installation-readback-response/1",
            configuration: config,
            proof: {
              schema: "pirate.web2-installation-readback/1",
              ...message,
              signature,
            },
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    };
    const enrollment = createHostedEnrollmentService(runtime),
      funding = createHostedFundingService(runtime);
    const post = async (
      path: string,
      body: unknown,
      handler?: (request: Request) => Promise<Response>,
    ) => {
      const selected = handler ?? (worker ? async (request: Request) => worker.request(new URL(request.url).pathname, { method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) }) : path === "/initial-topup" ? funding : enrollment);
      const response = await selected(
        new Request(policy.serviceOrigin + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const registrationInput = async (
      opts: {
        controller?: Address;
        publisher?: Address;
      } = {},
    ) => {
      const key = publicId(),
        installationId = publicId();
      const profile = validateWeb2Profile({
        ...policy.deployment,
        communityKey: key,
        communityId: directoryInstanceId(chainId, key),
        installationId,
      });
      const config: Web2CommunityConfig = {
        schema: "pirate.community-config/4",
        chainId,
        directory,
        communityId: profile.communityId,
        communityKey: key,
        installationId,
        configurationRevision: 1,
        postsContract: posts.address,
        controller: lower(opts.controller ?? controller.address),
        publisher: lower(opts.publisher ?? publisher.address),
        operatorPayments: zero,
        learningRecords: zero,
        app: { label: "Hosted fixture", origin: "https://community.example" },
        feed: {
          endpoint: "https://community.example/api/feed",
          signingKeyId: "fixture",
        },
        policies: {
          admission: {
            version: UNREGISTERED_OWNER_POLICY_VERSION,
            sha256: UNREGISTERED_OWNER_POLICY_HASH,
          },
          moderationSigner: lower(stranger.address),
        },
        publisherRevocations: [],
      };
      const bytes = new TextEncoder().encode(canonical(config)),
        pin = await preparePin(bytes, "application/json");
      pins.set(pin.uri, bytes);
      installations.set(config.communityId, {
        config,
        publisherAccount: (opts.publisher ?? publisher.address).toLowerCase() === publisher.address.toLowerCase() ? publisher : controller,
      });
      return {
        profile,
        config,
        body: {
          profile: web2ProfileDocument(profile),
          config,
          uri: pin.uri,
          noticeSha256: policy.noticeSha256,
        },
      };
    };
    const invite = async (
      opts: {
        controller?: Address;
        publisher?: Address;
        allowanceId?: Hex;
        ttl?: number;
      } = {},
    ) => {
      const id = publicId(),
        secret = token(),
        allowanceId = opts.allowanceId ?? publicId();
      await provisionHostedInvite(
        db,
        policy,
        {
          id,
          token: secret,
          allowanceId,
          expiresAt: state.clock + (opts.ttl ?? 3600),
        },
        state.clock,
        pkg?.profile.configuration.schemaContext,
      );
      const selected = await registrationInput(opts);
      const body = {
        ...selected.body,
        inviteToken: secret,
      };
      return { id, secret, allowanceId, profile: selected.profile, config: selected.config, body };
    };
    const permissionless = async (
      opts: {
        controller?: Address;
        publisher?: Address;
      } = {},
    ) => {
      const selected = await registrationInput(opts);
      return { profile: selected.profile, config: selected.config, body: selected.body };
    };
    const prepare = async (
      i: { body: unknown },
      signerAccount = controller,
    ) => {
      const response = await post("/prepare", i.body);
      assert.equal(response.status, 200, JSON.stringify(response));
      const e = await loadEnrollment(db, response.body.enrollmentId as Hex);
      const controllerSignature = await signerAccount.signTypedData(
        enrollmentTypedData(e),
      );
      return { e, auth: { enrollmentId: e.id, controllerSignature } };
    };
    return {
      runtime,
      worker,
      get db() { return db; },
      policy,
      state,
      client,
      local,
      rpc,
      wallet,
      directory,
      accounts: { admin, registrar, funder, controller, publisher, stranger },
      mine,
      post,
      invite,
      permissionless,
      prepare,
      pins,
      compiled,
      posts,
      proxyUrl,
      enrollment,
      funding,
      async close() {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await mf.dispose();
        await evidence("cleanup", { anvilPid: child.pid, pidMeaning: "runner namespace-local, not host ID", proxyClosed: true, miniflareDisposed: true, journalRetained: journal });
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
      },
    };
  } catch (error) {
    proxy.closeAllConnections();
    proxy.close();
    await mf.dispose();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    throw error;
  }
}
