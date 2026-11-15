// Disposable real Anvil + D1; public fixture keys never leave this local chain.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import assert from "node:assert/strict";
import solc from "solc";
import { Miniflare } from "miniflare";
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
export async function hostedFixture(overrides: Partial<HostedPolicy> = {}) {
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
      "31337",
      "--timestamp",
      "1800000000",
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
    chain: foundry,
  });
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('unused fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  const pins = new Map<string, Uint8Array>(),
    state = {
      dropSend: 0,
      dropBeforeSend: 0,
      sendCount: 0,
      clock: 1800000030,
      invalidPin: false,
      failRpc: false,
      beforeSend: undefined as (() => Promise<void>) | undefined,
    };
  // A real HTTP transport proxy may lose a response only after the actual RPC
  // processed it. It does not fabricate chain methods or successful receipts.
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    if (req.url?.startsWith("/ipfs/")) {
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
      chain: foundry,
    });
    const hash = await wallet.deployContract({
      abi: compiled.CommunityDirectoryV3!.abi,
      bytecode: compiled.CommunityDirectoryV3!.bytecode,
      args: [admin.address],
    });
    const receipt = await local.waitForTransactionReceipt({ hash });
    assert(receipt.contractAddress);
    const directory = lower(receipt.contractAddress);
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
    const db = await mf.getD1Database("DB"),
      sql = readFileSync(
        "packages/community/schema/hosted-enrollment.sql",
        "utf8",
      );
    await db.batch(
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
        chainId: 31337,
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
    const signer = (a: typeof admin): HostedSigner => ({
      address: lower(a.address),
      signTransaction: async (tx) => a.signTransaction(tx),
    });
    const runtime: HostedRuntime = {
      db,
      policy,
      client,
      now: () => state.clock,
      registrar: signer(registrar),
      funder: signer(funder),
      readConfiguration: async (uri) =>
        fetch(`${proxyUrl}/ipfs/${uri.slice(7)}`),
    };
    const enrollment = createHostedEnrollmentService(runtime),
      funding = createHostedFundingService(runtime);
    const post = async (
      path: string,
      body: unknown,
      handler = path === "/initial-topup" ? funding : enrollment,
    ) => {
      const response = await handler(
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
        allowanceId = opts.allowanceId ?? publicId(),
        key = publicId(),
        installationId = publicId();
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
      );
      const profile = validateWeb2Profile({
        ...policy.deployment,
        communityKey: key,
        communityId: directoryInstanceId(31337, key),
        installationId,
      });
      const config: Web2CommunityConfig = {
        schema: "pirate.community-config/4",
        chainId: 31337,
        directory,
        communityId: profile.communityId,
        communityKey: key,
        installationId,
        configurationRevision: 1,
        postsContract: lower(stranger.address),
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
      const body = {
        inviteToken: secret,
        profile: web2ProfileDocument(profile),
        config,
        uri: pin.uri,
        noticeSha256: policy.noticeSha256,
      };
      return { id, secret, allowanceId, profile, config, body };
    };
    const prepare = async (
      i: Awaited<ReturnType<typeof invite>>,
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
      db,
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
      prepare,
      pins,
      compiled,
      enrollment,
      funding,
      async close() {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await mf.dispose();
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
