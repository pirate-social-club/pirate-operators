// Actual disposable RPC/contracts. Only public test keys are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashText } from "../../packages/community/common.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { directoryInstanceId } from "../../packages/community/shared-identity.ts";
import {
  directoryV3Abi,
  directoryV3Build,
  validateWeb2Profile,
  web2ProfileDocument,
} from "../../packages/community/web2-directory.ts";
import {
  bindWeb2RegistrationTransaction,
  observeWeb2Registration,
  prepareWeb2Registration,
} from "../../packages/community/web2-registration-chain.ts";
import { validateWeb2Configuration } from "../../packages/community/web2-config-manifest.ts";
import type { RecognitionProfile } from "../../packages/recognition/intent.ts";
import {
  CATALOG_OWNER_POLICY_HASH,
  CATALOG_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";

export const web2Owner = privateKeyToAccount(`0x${"51".repeat(32)}`),
  web2Other = privateKeyToAccount(`0x${"52".repeat(32)}`),
  web2Controller = privateKeyToAccount(`0x${"41".repeat(32)}`),
  web2Publisher = privateKeyToAccount(`0x${"11".repeat(32)}`);
const web2Admin = privateKeyToAccount(`0x${"61".repeat(32)}`);

export async function web2SongChain(recognition: RecognitionProfile, options: {contractController?:boolean} = {}) {
  const portReservation = createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    portReservation.close((e) => (e ? reject(e) : resolve())),
  );
  const startedAt = new Date().toISOString(),
    timestamp = Math.floor(Date.now() / 1000) - 300;
  const child = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "6343",
      "--timestamp",
      String(timestamp),
      "--block-base-fee-per-gas",
      "1000000",
      "--gas-price",
      "1000000",
      "--disable-min-priority-fee",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const network = defineChain({
      id: 6343,
      name: "Disposable Web2 integration",
      nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
    }),
    direct = `http://127.0.0.1:${port}`;
  const client = createPublicClient({
    chain: network,
    transport: http(direct, { retryCount: 0, timeout: 1000 }),
    cacheTime: 0,
    pollingInterval: 20,
  });
  const contents = new Map<string, Uint8Array>(),
    effects = { broadcasts: 0, catalogUploads: 0, pinAdds: 0 },
    rpcMethods: string[] = [];
  let unavailable = false,
    loseBroadcastAck = false,
    broadcastAckLost = false;
  let afterVerification: (()=>Promise<void>) | undefined;
  const broadcastTransactions: Hex[] = [];
  const gateway = httpServer(async (req, res) => {
    try {
      if (req.url === "/rpc") {
        if (unavailable) {
          res.writeHead(503);
          res.end("explicit canonical RPC outage");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks),
          calls = JSON.parse(body.toString()) as
            | { method: string; params?: Hex[] }
            | { method: string; params?: Hex[] }[];
        let broadcast = false;
        for (const call of Array.isArray(calls) ? calls : [calls]) {
          rpcMethods.push(call.method);
          if (call.method === "eth_sendRawTransaction") {
            effects.broadcasts++;
            broadcast = true;
            assert.ok(call.params?.[0]);
            broadcastTransactions.push(call.params[0]);
          }
        }
        const response = await fetch(direct, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if ((Array.isArray(calls) ? calls : [calls]).some(c=>c.method === "eth_call") && afterVerification) {
          const after=afterVerification;afterVerification=undefined;await after();
        }
        if (
          broadcast &&
          loseBroadcastAck &&
          typeof JSON.parse(bytes.toString()).result === "string"
        ) {
          loseBroadcastAck = false;
          broadcastAckLost = true;
          res.destroy();
          return;
        }
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(bytes);
        return;
      }
      const bytes = contents.get((req.url ?? "").slice("/ipfs/".length));
      res.writeHead(bytes ? 200 : 404);
      res.end(
        bytes ? Buffer.from(bytes) : "missing explicit simulated IPFS object",
      );
    } catch (error) {
      res.writeHead(503);
      res.end(String(error));
    }
  });
  let gatewayStarted = false,
    closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (gatewayStarted) {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
    if (child.exitCode === null && child.signalCode === null) {
      const terminal = once(child, "exit");
      // Only this owned child handle may be signalled; unrelated services stay untouched.
      const deadline = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 2000);
      try {
        child.kill("SIGTERM");
        await terminal;
      } finally {
        clearTimeout(deadline);
      }
    }
    await mkdir(".local/web2-owner-signing-implementation/first-song", { recursive: true });
    await writeFile(
      `.local/web2-owner-signing-implementation/first-song/anvil-${child.pid}.json`,
      JSON.stringify(
        {
          pid: child.pid,
          startedAt,
          port,
          exitCode: child.exitCode,
          signal: child.signalCode,
          stderr,
        },
        null,
        2,
      ),
    );
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error("owned_anvil_exited: " + stderr);
      try {
        assert.equal(await client.getChainId(), 6343);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    assert.ok(ready, "actual owned Anvil must become ready");
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    gatewayStarted = true;
    const gatewayOrigin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    async function rpc(method: string, params: unknown[] = []) {
      const response = await fetch(direct, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const value = (await response.json()) as {
        result: unknown;
        error?: unknown;
      };
      assert.equal(value.error, undefined, JSON.stringify(value.error));
      return value.result;
    }
    for (const account of [
      web2Owner,
      web2Other,
      web2Controller,
      web2Publisher,
      web2Admin,
    ])
      await rpc("anvil_setBalance", [account.address, "0x3635c9adc5dea00000"]);
    const wallet = createWalletClient({
      chain: network,
      transport: http(direct),
      account: web2Controller,
    });
    const adminWallet = createWalletClient({
      chain: network,
      transport: http(direct),
      account: web2Admin,
    });
    async function artifact(name: string) {
      const raw = JSON.parse(
        await readFile(`out/${name}.sol/${name}.json`, "utf8"),
      );
      assert.ok(
        raw.bytecode.object,
        "run forge build before this integration test",
      );
      return raw as { abi: Abi; bytecode: { object: Hex } };
    }
    const directoryArtifact = await artifact("CommunityDirectoryV3"),
      postsArtifact = await artifact("CommunityPostsV1");
    async function deploy(
      artifact: typeof directoryArtifact,
      args: readonly unknown[],
    ) {
      const hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args,
        gasPrice: 1000000n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.ok(receipt.contractAddress);
      return {
        address: receipt.contractAddress.toLowerCase() as Address,
        block: receipt.blockNumber,
      };
    }
    const directory = await deploy(directoryArtifact, [web2Admin.address]),
      posts = await deploy(postsArtifact, [directory.address]);
    assert.equal(
      keccak256((await client.getCode({ address: directory.address }))!),
      directoryV3Build.runtimeCodeHash,
    );
    const profile = validateWeb2Profile({
      schema: "pirate.web2-directory/3",
      chainId: 6343,
      directory: directory.address,
      directoryCodeHash: directoryV3Build.runtimeCodeHash,
      directoryAbiSha256: directoryV3Build.abiSha256,
      sourceCommit: "aef30d0cbcdd8f10dd884ffa988292561c7e8267",
      deploymentBlock: directory.block,
      communityKey: hashText("actual Web2 first-song key"),
      communityId: directoryInstanceId(
        6343,
        hashText("actual Web2 first-song key"),
      ),
      installationId: hashText("actual Web2 first-song installation"),
    });
    let controller = web2Controller.address.toLowerCase() as Address;
    if(options.contractController) {
      const account=await artifact("MockAccount"), deployed=await deploy(account,[]);
      await client.waitForTransactionReceipt({hash:await wallet.writeContract({address:deployed.address,abi:account.abi,
        functionName:"initialize",args:[web2Controller.address],gasPrice:1000000n})});
      controller=deployed.address;
    }
    let config = validateWeb2Configuration(
      {
        schema: "pirate.community-config/4",
        chainId: 6343,
        directory: directory.address,
        communityKey: profile.communityKey,
        communityId: profile.communityId,
        installationId: profile.installationId,
        configurationRevision: 1,
        postsContract: posts.address,
        controller,
        publisher: web2Publisher.address.toLowerCase(),
        operatorPayments: "0x" + "0".repeat(40),
        learningRecords: "0x" + "0".repeat(40),
        app: {
          label: "Actual Web2 first song",
          origin: "https://web2.community.example",
        },
        feed: {
          endpoint: "https://web2.community.example/api/feed",
          signingKeyId: "actual-web2-fixture",
        },
        policies: {
          admission: {
            version: CATALOG_OWNER_POLICY_VERSION,
            sha256: CATALOG_OWNER_POLICY_HASH,
          },
          moderationSigner: web2Controller.address.toLowerCase(),
          recognition,
        },
        publisherRevocations: [],
      },
      profile,
    );
    async function write(
      functionName: string,
      args: readonly unknown[],
      admin = false,
    ) {
      const hash = await (admin ? adminWallet : wallet).writeContract({
        address: directory.address,
        abi: directoryArtifact.abi,
        functionName,
        args,
        gasPrice: 1000000n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    }
    await write(
      "configureRegistrar",
      [web2Controller.address, BigInt(timestamp + 3600), 10n, 0n],
      true,
    );
    const firstBytes = new TextEncoder().encode(canonical(config)),
      pin = await preparePin(firstBytes, "application/json");
    contents.set(pin.uri.slice(7), firstBytes);
    const plan = prepareWeb2Registration(
        profile,
        config,
        pin.uri,
        web2Controller.address.toLowerCase() as Address,
        1n,
      ),
      limits = {
        nonce: await client.getTransactionCount({
          address: web2Controller.address,
        }),
        gas: 3000000n,
        maxFeePerGas: 1000000n,
        maxPriorityFeePerGas: 1n,
      },
      raw = await web2Controller.signTransaction({
        chainId: 6343,
        type: "eip1559",
        to: directory.address,
        data: plan.data,
        value: 0n,
        ...limits,
      }),
      original = await bindWeb2RegistrationTransaction(plan, raw, limits);
    await client.sendRawTransaction({ serializedTransaction: raw });
    await client.waitForTransactionReceipt({ hash: original.transactionHash });
    await rpc("anvil_mine", ["0x40", "0x0"]);
    const enrolled = await observeWeb2Registration(client, original);
    assert.equal(enrolled.status, "consumed");
    const deployment = {
      schema: "pirate.community-deployment/2" as const,
      origin: config.app.origin,
      name: config.app.label,
      planId: hashText("actual first-song deployment").slice(2),
      postingPeriod: "actual-web2-first-song",
      rpcUrl: gatewayOrigin + "/rpc",
      ipfsGateways: [gatewayOrigin],
      managedOrigin: "https://managed.web2.example",
      directoryProfile: web2ProfileDocument(profile),
      posts: {
        address: posts.address,
        runtimeCodeHash: keccak256(
          (await client.getCode({ address: posts.address }))!,
        ),
        deploymentBlock: String(posts.block),
      },
      freshness: { maxSafeBlockAgeSeconds: "600" },
    };
    return {
      client,
      profile,
      deployment,
      contents,
      effects,
      rpcMethods,
      original,
      enrolled,
      close,
      rpc,
      broadcastTransactions,
      loseNextBroadcastAcknowledgement: () => {
        loseBroadcastAck = true;
      },
      broadcastAcknowledgementLost: () => broadcastAckLost,
      current: () => config,
      afterNextVerification:(action:()=>Promise<void>)=>{afterVerification=action;},
      unavailable: (value: boolean) => {
        unavailable = value;
      },
      async nextRevision() {
        config = validateWeb2Configuration(
          {
            ...config,
            configurationRevision: config.configurationRevision + 1,
            app: { ...config.app, label: "Updated title" },
          },
          profile,
        );
        const bytes = new TextEncoder().encode(canonical(config)),
          reference = await preparePin(bytes, "application/json");
        contents.set(reference.uri.slice(7), bytes);
        await write("configure", [
          config.communityId,
          BigInt(config.configurationRevision - 1),
          {
            controller: config.controller,
            publisher: config.publisher,
            operatorPayments: config.operatorPayments,
            learningRecords: config.learningRecords,
            sha256Digest: reference.sha256,
            uri: reference.uri,
          },
        ]);
        await rpc("anvil_mine", ["0x40", "0x0"]);
      },
      async expireDiscovery() {
        await write(
          "setVerificationRoles",
          [web2Admin.address, web2Admin.address, web2Admin.address],
          true,
        );
        const block = await client.getBlock();
        await write(
          "verifyWeb2",
          [
            config.communityId,
            0n,
            {
              originRevision: 1n,
              controllerRevision: 1n,
              observedAt: block.timestamp,
              validUntil: block.timestamp + 20n,
              evidenceSha256: hashText(
                "explicit fixture HTTP verification evidence",
              ),
            },
          ],
          true,
        );
        await rpc("anvil_mine", ["0x40", "0x0"]);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Independent fixture projection of the public V2 contract. It deliberately
 * does not call the production payload builder used by verification. */
export function web2OwnerAuthorizationData(a: import("../../packages/community/owner-authorization.ts").OwnerAuthorization,
  config: import("../../packages/community/config-manifest.ts").CommunityConfig) {
  return {domain:{name:"Pirate Owner Publishing Authorization",version:"2",chainId:config.chainId,verifyingContract:config.directory as Address},
    primaryType:"OwnerPublishingAuthorization" as const,types:{OwnerPublishingAuthorization:[
      {name:"schema",type:"string"},{name:"communityId",type:"bytes32"},{name:"ownerWallet",type:"address"},
      {name:"policyVersion",type:"string"},{name:"policySha256",type:"bytes32"},{name:"validFrom",type:"uint64"},{name:"expiresAt",type:"uint64"}]},
    message:{schema:a.schema,communityId:a.communityId as Hex,ownerWallet:a.ownerWallet as Address,policyVersion:a.policy.version,
      policySha256:a.policy.sha256 as Hex,validFrom:BigInt(a.validFrom),expiresAt:BigInt(a.expiresAt)}};
}
