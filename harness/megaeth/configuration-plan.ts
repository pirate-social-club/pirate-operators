import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
} from "viem";
import {
  canonical,
  hashJson,
  hashText,
  insist,
} from "../../packages/community/common.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  address,
} from "../../packages/community/manifest-core.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import { preparePin } from "../../packages/community/ipfs.ts";

export const configurationChain = defineChain({
  id: 6343,
  name: "MegaETH Testnet",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://carrot.megaeth.com/rpc"] } },
});
export const configurationClient = () =>
  createPublicClient({
    chain: configurationChain,
    transport: http(configurationChain.rpcUrls.default.http[0], {
      timeout: 15000,
      retryCount: 0,
      fetchOptions: { redirect: "error" },
    }),
  });
export async function configurationPlan() {
  const deployed = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.contracts.json",
      "utf8",
    ),
  );
  const manifest = validateConfig({
    schema: "pirate.community-config/1",
    chainId: 6343,
    directory: deployed.directory.address,
    registry: deployed.registry.address,
    communityId: deployed.communityId,
    tld: "firstsong-20261105",
    configurationRevision: 1,
    postsContract: deployed.posts.address,
    controller: deployed.registry.admin.toLowerCase(),
    publisher: "0x14b90a55657d9695a727254eaec5e0e32d20d602",
    operatorPayments: `0x${"0".repeat(40)}`,
    learningRecords: `0x${"0".repeat(40)}`,
    app: {
      label: "app",
      tokenGeneration: "0",
      origin: deployed.profile.origin,
      httpsAlias: null,
      hnsIngress: "none",
    },
    feed: {
      endpoint: deployed.profile.origin + "/api/feed",
      signingKeyId: "community-publisher-6343-v1",
    },
    policies: {
      admission: { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
      moderationSigner: "0xa67ac40bc3d5e1b25d7da5ca2e8585f335a37329",
    },
    publisherRevocations: [],
  });
  insist(
    manifest.registry === "0x7a385a404d98ce83747650f7ca254004b8d59609" &&
      manifest.directory === "0x7d67b9d276aa8c91a3579900a44bbb3096752e8a" &&
      manifest.controller === "0x274f223809f00cbdd51d05de3abc8fd3368fde16",
    "wrong_first_song_deployment",
  );
  const bytes = new TextEncoder().encode(canonical(manifest)),
    pin = await preparePin(bytes, "application/json");
  const configuration = {
    controller: address(manifest.controller),
    publisher: manifest.publisher,
    operatorPayments: manifest.operatorPayments,
    learningRecords: manifest.learningRecords,
    sha256Digest: pin.sha256,
    uri: pin.uri,
  };
  const call = {
    to: address(manifest.directory),
    data: encodeFunctionData({
      abi: directoryAbi,
      functionName: "registerCommunity",
      args: [manifest.registry, configuration],
    }),
    gas: 1000000n,
  };
  const sourcePaths = [
    "harness/megaeth/configuration-plan.ts",
    "harness/megaeth/configure-community.ts",
    "harness/megaeth/deployment-journal.ts",
    "packages/community/ipfs.ts",
    "packages/community/directory-reader.ts",
    "packages/community/config-manifest.ts",
    "packages/community/manifest-core.ts",
    "packages/community/common.ts",
    "packages/protocol/index.ts",
    "package-lock.json",
    "apps/community-wizard/server/infisical-auth.ts",
    "apps/community-wizard/server/model.ts",
    "apps/community-wizard/package-lock.json",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        hashText(await readFile(path, "utf8")),
      ]),
    ),
  );
  const profile = {
    schema: "pirate.first-song-configuration-plan/1",
    manifest,
    pin,
    transaction: {
      to: call.to,
      data: call.data,
      gas: call.gas.toString(),
      nonce: 17,
    },
    directoryProfile: {
      chainId: 6343 as const,
      communityId: manifest.communityId,
      registry: address(manifest.registry),
      directory: address(manifest.directory),
      directoryCodeHash: deployed.directory.runtimeCodeHash,
      deploymentBlock: deployed.directory.blockNumber,
    },
    sourceHashes,
    bounds: {
      pinAdds: 1,
      pinBytes: bytes.length,
      transactions: 1,
      maximumGasPrice: "30000000",
      maximumTotalFee: "30000000000000",
      executionSeconds: 600,
    },
    credential: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      path: "/services/api-next",
      name: "FILEBASE_IPFS_TOKEN",
    },
    recovery:
      "Retain the original pin identity and signed transaction journal. Unknown pin sends are read-reconciled only; EVM retries reuse exact bytes and nonce.",
  };
  return { profile, profileHash: hashJson(profile), bytes, call };
}

export async function configurationPreflight(
  planned: Awaited<ReturnType<typeof configurationPlan>>,
) {
  const { profile, profileHash } = planned,
    client = configurationClient();
  insist((await client.getChainId()) === 6343, "refusing_non_megaeth_testnet");
  const [code, latest, pending, estimate, balance] = await Promise.all([
    client.getCode({ address: planned.call.to }),
    client.getTransactionCount({
      address: profile.manifest.controller,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: profile.manifest.controller,
      blockTag: "pending",
    }),
    client.estimateGas({
      account: profile.manifest.controller,
      to: planned.call.to,
      data: planned.call.data,
    }),
    client.getBalance({ address: profile.manifest.controller }),
  ]);
  insist(
    code && keccak256(code) === profile.directoryProfile.directoryCodeHash,
    "configuration_directory_code_changed",
  );
  return {
    profileHash,
    chainId: 6343,
    latest,
    pending,
    estimatedGas: estimate.toString(),
    gasLimit: planned.call.gas.toString(),
    balance: balance.toString(),
    at: new Date().toISOString(),
  };
}
