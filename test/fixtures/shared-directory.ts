// Adapted from the b25 V1 RPC fixture; explicitly simulated RPC, not chain acceptance.
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  decodeFunctionData,
  type Hex,
} from "viem";
import { canonical, hashText, insist, object } from "../../packages/community/common.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../../packages/community/manifest-core.ts";
import {
  directoryAbi,
  readConfiguration,
} from "../../packages/community/directory-reader.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { directoryInstanceId, sharedNamespaceId } from "../../packages/community/shared-identity.ts";
import { acceptedSharedRegistry, sharedBinding, sharedDirectoryAbi, type SharedDirectoryProfile } from "../../packages/community/shared-directory.ts";

const addr = (s: string) => `0x${s.repeat(40)}` as const,
  hash = (s: string) => `0x${s.repeat(64)}` as const;
export async function sharedDirectoryFixture(fault = "") {
  const config = {
    schema: "pirate.community-config/2",
    chainId: 31337,
    directory: addr("1"),
    registry: addr("2"),
    communityId: directoryInstanceId(31337, hash("d")),
    communityKey: hash("d"),
    installationId: hash("e"),
    namespaceId: sharedNamespaceId("fixture"),
    registryCodeHash: keccak256("0x60006000"),
    registrySourceCommit: acceptedSharedRegistry.sourceCommit,
    registryAbiSha256: acceptedSharedRegistry.abiSha256,
    postsContract: addr("3"),
    tld: "fixture",
    configurationRevision: 1,
    controller: addr("4"),
    publisher: fault === "manifest" ? addr("9") : addr("5"),
    operatorPayments: addr("0"),
    learningRecords: addr("0"),
    app: {
      label: "app",
      tokenGeneration: "0",
      origin: "https://community.example",
      httpsAlias: null,
      hnsIngress: "none",
    },
    feed: {
      endpoint: "https://community.example/api/feed",
      signingKeyId: "fixture",
    },
    policies: {
      admission: { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
      moderationSigner: addr("6"),
    },
    publisherRevocations: [] as {
      postsContract: string;
      publisher: string;
      fromBlock: string;
    }[],
  };
  const state = {
    head: 100n,
    hash: hash("a"),
    logRanges: [] as [bigint, bigint][],
    downloads: 0,
  };
  const configurations = [config],
    code = "0x60006000";
  if (fault === "cutoff")
    configurations.push({
      ...config,
      configurationRevision: 2,
      publisher: addr("7"),
      publisherRevocations: [
        { postsContract: addr("3"), publisher: addr("5"), fromBlock: "70" },
      ],
    });
  const records = await Promise.all(
    configurations.map(async (c) => {
      let encoded = canonical(c);
      if (fault === "pretty") encoded = JSON.stringify(c, null, 2);
      if (fault === "duplicates")
        encoded = encoded.replace(
          '"tld":"fixture"',
          '"tld":"other","tld":"fixture"',
        );
      const bytes = new TextEncoder().encode(encoded),
        pin = await preparePin(bytes, "application/json");
      return {
        block: 51n + BigInt(c.configurationRevision - 1),
        bytes,
        pin,
        chainConfig: {
          controller: c.controller,
          publisher: fault === "manifest" ? addr("5") : c.publisher,
          operatorPayments: c.operatorPayments,
          learningRecords: c.learningRecords,
          sha256Digest: pin.sha256,
          uri: pin.uri,
        },
      };
    }),
  );
  const profile: SharedDirectoryProfile = {
    schema: "pirate.shared-directory/2", chainId: 31337,
    directory: config.directory, registry: config.registry, communityId: config.communityId,
    communityKey: config.communityKey, installationId: config.installationId,
    hostingOrigin: config.app.origin, tld: config.tld, namespaceId: config.namespaceId,
    registryCodeHash: config.registryCodeHash, registrySourceCommit: config.registrySourceCommit,
    registryAbiSha256: config.registryAbiSha256, deploymentBlock: 50n, directoryCodeHash: keccak256(code),
  };
  let blocks = 0;
  // Explicit RPC fixture tests reader logic; live chain qualification is separate.
  const allLogs = () =>
    records.map((record, index) => ({
      address: config.directory,
      blockHash: state.hash,
      blockNumber: `0x${record.block.toString(16)}`,
      data: encodeAbiParameters(
        directoryAbi[1].inputs.filter(
          (input) => !("indexed" in input && input.indexed),
        ),
        [
          BigInt(
            record.chainConfig
              ? configurations[index].configurationRevision
              : index + 1,
          ),
          record.chainConfig.controller,
          record.chainConfig.publisher,
          record.chainConfig.operatorPayments,
          record.chainConfig.learningRecords,
          record.pin.sha256,
          record.pin.uri,
        ],
      ),
      topics: encodeEventTopics({
        abi: directoryAbi,
        eventName: "ConfigurationPublished",
        args: { communityId: config.communityId },
      }),
      logIndex: `0x${records.slice(0, index).filter((r) => r.block === record.block).length.toString(16)}`,
      transactionHash: keccak256(new TextEncoder().encode(`config-${index}`)),
      transactionIndex: "0x0",
      removed: false,
    }));
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        switch (method) {
          case "eth_chainId":
            return fault === "chain" ? "0x1" : "0x7a69";
          case "eth_blockNumber":
            return `0x${state.head.toString(16)}`;
          case "eth_getCode":
            return code;
          case "eth_getBlockByNumber":
            if (BigInt(params?.[0] as string) > state.head) return null;
            return {
              number: params?.[0],
              hash: fault === "reorg" && blocks++ ? hash("b") : state.hash,
              parentHash: hash("c"),
              timestamp: "0x6b49d200",
              transactions: [],
            };
          case "eth_getLogs": {
            const filter = params?.[0] as {
              fromBlock: string;
              toBlock: string;
            };
            const from = BigInt(filter.fromBlock),
              to = BigInt(filter.toBlock);
            state.logRanges.push([from, to]);
            return allLogs().filter(
              (log) =>
                BigInt(log.blockNumber) >= from &&
                BigInt(log.blockNumber) <= to,
            );
          }
          case "eth_getTransactionReceipt": {
            const log = allLogs().find(
              (log) => log.transactionHash === params?.[0],
            );
            if (!log) return null;
            return {
              transactionHash: log.transactionHash,
              transactionIndex: "0x0",
              blockHash: state.hash,
              blockNumber: log.blockNumber,
              from: addr("4"),
              to: config.directory,
              contractAddress: null,
              cumulativeGasUsed: "0x1",
              gasUsed: "0x1",
              effectiveGasPrice: "0x1",
              logs: [log],
              logsBloom: "0x" + "0".repeat(512),
              status: "0x1",
              type: "0x0",
            };
          }
          case "eth_call": {
            const data = object(params?.[0]).data;
            insist(typeof data === "string" && /^0x[0-9a-f]+(?![\s\S])/.test(data), "fixture_calldata");
            const call = decodeFunctionData({ abi: sharedDirectoryAbi, data: data as Hex });
            if (call.functionName === "admin") return encodeFunctionResult({ abi: sharedDirectoryAbi, functionName: "admin", result: config.controller });
            if (call.functionName === "registrySource") return encodeFunctionResult({ abi: sharedDirectoryAbi, functionName: "registrySource", result: {
              runtimeCodeHash: profile.registryCodeHash, sourceCommit: ("0x" + profile.registrySourceCommit) as Hex, abiSha256: profile.registryAbiSha256,
            } });
            if (call.functionName === "getBinding") return encodeFunctionResult({
              abi: sharedDirectoryAbi, functionName: "getBinding",
              result: fault === "binding" ? { ...sharedBinding(profile), installationId: hash("f") } : sharedBinding(profile),
            });
            const eligible = records.filter(
              (r) => r.block <= BigInt(params?.[1] as string),
            );
            const { chainConfig, pin } = eligible.at(-1)!;
            return encodeFunctionResult({
              abi: directoryAbi,
              functionName: "getCommunity",
              result: {
                registry: config.registry,
                tldHash: hashText(config.tld),
                configurationRevision: BigInt(eligible.length),
                configuration: {
                  ...chainConfig,
                  sha256Digest: fault === "state" ? hash("e") : pin.sha256,
                },
                verificationRevision: 0n,
                verification: {
                  configurationRevision: 0n,
                  hnsHeight: 0n,
                  hnsBlockHash: hash("0"),
                  observedAt: 0n,
                  validUntil: 0n,
                  evidenceSha256: hash("0"),
                },
                listingRevision: 0n,
                listed: false,
              },
            });
          }
          default:
            throw new Error("unexpected fixture RPC method:" + method);
        }
      },
    }),
  });
  return {
    config,
    client,
    state,
    records,
    profile,
    transport: async (request: Request) => {
      state.downloads++;
      return new Response(
        records.find((r) => request.url.includes(r.pin.uri.slice(7)))!.bytes,
      );
    },
    async extend() {
      const next = {
        ...config,
        configurationRevision: configurations.length + 1,
        publisher: addr("7"),
      };
      configurations.push(next);
      const bytes = new TextEncoder().encode(canonical(next)),
        pin = await preparePin(bytes, "application/json");
      records.push({
        bytes,
        pin,
        block: state.head - 1n,
        chainConfig: {
          controller: next.controller,
          publisher: next.publisher,
          operatorPayments: next.operatorPayments,
          learningRecords: next.learningRecords,
          sha256Digest: pin.sha256,
          uri: pin.uri,
        },
      });
      return next;
    },
    read: () =>
      readConfiguration(
        client,
        profile,
        async (request) =>
          new Response(
            fault === "bytes"
              ? new Uint8Array([0])
              : new Uint8Array(
                  records.find((r) =>
                    request.url.includes(r.pin.uri.slice(7)),
                  )!.bytes,
                ),
          ),
      ),
  };
}
