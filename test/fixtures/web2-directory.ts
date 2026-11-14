// Explicit simulated RPC/IPFS; the bytecode and ABI come from actual solc output.
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Hex,
} from "viem";
import {
  canonical,
  hashText,
  insist,
  object,
} from "../../packages/community/common.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { directoryInstanceId } from "../../packages/community/shared-identity.ts";
import {
  directoryV3Abi as abi,
  directoryV3Build as build,
  validateWeb2Profile,
  web2Binding,
} from "../../packages/community/web2-directory.ts";
import { directoryV3Runtime } from "../../packages/community/generated/directory-v3.ts";
import {
  UNREGISTERED_OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
} from "../../packages/community/owner-policy.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";

export const a = (s: string): Hex => `0x${s.repeat(40)}`;
export const h = (s: string): Hex => `0x${s.repeat(64)}`;
export async function web2DirectoryFixture(count = 1, fault = "") {
  const config: Web2CommunityConfig = {
    schema: "pirate.community-config/3",
    chainId: 31337,
    directory: a("1"),
    communityKey: h("d"),
    communityId: directoryInstanceId(31337, h("d")),
    installationId: h("e"),
    configurationRevision: 1,
    postsContract: a("3"),
    controller: a("4"),
    publisher: a("5"),
    operatorPayments: a("0"),
    learningRecords: a("0"),
    app: { label: "Web2 community", origin: "https://community.example" },
    feed: {
      endpoint: "https://community.example/api/feed",
      signingKeyId: "fixture",
    },
    policies: {
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
      moderationSigner: a("6"),
    },
    publisherRevocations: [],
  };
  const profile = validateWeb2Profile({
    schema: "pirate.web2-directory/3",
    chainId: 31337,
    directory: config.directory,
    directoryCodeHash: build.runtimeCodeHash,
    directoryAbiSha256: build.abiSha256,
    sourceCommit: "1".repeat(40),
    deploymentBlock: 50n,
    communityId: config.communityId,
    communityKey: config.communityKey,
    installationId: config.installationId,
  });
  const records = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const origin =
        i === 0 || i === 2 ? config.app.origin : "https://new.example";
      const c = {
        ...config,
        configurationRevision: i + 1,
        app: { ...config.app, origin },
        feed: { ...config.feed, endpoint: origin + "/api/feed" },
      };
      const bytes = new TextEncoder().encode(canonical(c)),
        pin = await preparePin(bytes, "application/json");
      return {
        c,
        bytes,
        pin,
        block: 51n + BigInt(i),
        origin: {
          sha256Digest:
            fault === "hidden-origin" && i > 0
              ? hashText(config.app.origin)
              : hashText(origin),
          revision: BigInt(i + 1),
          controllerRevision: 1n,
        },
        chainConfig: {
          controller: c.controller,
          publisher: c.publisher,
          operatorPayments: c.operatorPayments,
          learningRecords: c.learningRecords,
          sha256Digest: pin.sha256,
          uri: pin.uri,
        },
      };
    }),
  );
  const state = {
    safe: BigInt(60 + count),
    safeTimestamp: 65536n,
    now: 65536n,
    web2VerifiedAtBlock: true,
    hnsVerifiedAtBlock: false,
    listed: true,
    web2ValidUntil: 65536n + 3600n,
    hnsValidUntil: 0n,
    blockTags: [] as string[],
    contractReadBlocks: [] as [string, string][],
    hash: h("a"),
    blockReads: 0,
    originalHash: undefined as Hex | undefined,
    from: a("4"),
    receiptStatus: "0x1",
    receiptMissing: false,
    queries: [] as Hex[],
    logRanges: [] as [bigint, bigint][],
    mutate: undefined as (() => void) | undefined,
  };
  const event = (name: string) => {
    const e = abi.find((x) => x.type === "event" && x.name === name);
    insist(e?.type === "event", "missing_fixture_event");
    return e;
  };
  function logs(index: number) {
    const r = records[index]!,
      tx =
        index === 0 && state.originalHash
          ? state.originalHash
          : keccak256(new TextEncoder().encode(`v3-config-${index}`));
    const base = {
      address: profile.directory,
      blockHash: state.hash,
      blockNumber: `0x${r.block.toString(16)}`,
      transactionHash: tx,
      transactionIndex: "0x0",
      removed: false,
    };
    const bound = event("CommunityBound"),
      origin = event("OriginConfigured"),
      published = event("ConfigurationPublished"),
      used = event("RegistrarConsumed");
    const result = [
      {
        ...base,
        logIndex: "0x2",
        topics: encodeEventTopics({
          abi,
          eventName: "OriginConfigured",
          args: { communityId: profile.communityId },
        }),
        data: encodeAbiParameters(
          origin.inputs.filter((x) => !x.indexed),
          [BigInt(index + 1), r.origin],
        ),
      },
      {
        ...base,
        logIndex: "0x3",
        topics: encodeEventTopics({
          abi,
          eventName: "ConfigurationPublished",
          args: { communityId: profile.communityId },
        }),
        data: encodeAbiParameters(
          published.inputs.filter((x) => !x.indexed),
          [
            BigInt(index + 1),
            r.c.controller,
            r.c.publisher,
            r.c.operatorPayments,
            r.c.learningRecords,
            r.pin.sha256,
            r.pin.uri,
          ],
        ),
      },
    ];
    if (index === 0)
      result.push(
        {
          ...base,
          logIndex: "0x1",
          topics: encodeEventTopics({
            abi,
            eventName: "CommunityBound",
            args: { communityId: profile.communityId },
          }),
          data: encodeAbiParameters(
            bound.inputs.filter((x) => !x.indexed),
            [web2Binding(profile)],
          ),
        },
        {
          ...base,
          logIndex: "0x4",
          topics: encodeEventTopics({
            abi,
            eventName: "RegistrarConsumed",
            args: { communityId: profile.communityId },
          }),
          data: encodeAbiParameters(
            used.inputs.filter((x) => !x.indexed),
            [1n, 1n],
          ),
        },
      );
    return result.sort((x, y) => Number(x.logIndex) - Number(y.logIndex));
  }
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_chainId")
          return fault === "chain" ? "0x1" : "0x7a69";
        if (method === "eth_getCode")
          return fault === "code" ? "0x6000" : directoryV3Runtime;
        if (method === "eth_getBlockByNumber") {
          state.blockTags.push(String(params?.[0]));
          if (fault === "safe-missing" && params?.[0] === "safe") return null;
          const number =
            params?.[0] === "safe"
              ? `0x${state.safe.toString(16)}`
              : params?.[0];
          if (typeof number !== "string" || BigInt(number) > state.safe + 100n)
            return null;
          return {
            number,
            hash:
              fault === "reorg" && state.blockReads++ > 0 ? h("b") : state.hash,
            parentHash: h("c"),
            timestamp:
              fault === "timestamp"
                ? undefined
                : `0x${state.safeTimestamp.toString(16)}`,
            transactions: [],
          };
        }
        if (method === "eth_getLogs") {
          const f = object(params?.[0]);
          insist(
            typeof f.fromBlock === "string" && typeof f.toBlock === "string",
            "fixture_range",
          );
          const from = BigInt(f.fromBlock),
            to = BigInt(f.toBlock);
          state.logRanges.push([from, to]);
          return records
            .flatMap((r, i) =>
              r.block >= from && r.block <= to
                ? logs(i).filter((x) => x.logIndex === "0x3")
                : [],
            )
            .filter((_, i) => fault !== "gap" || i !== 0);
        }
        if (method === "eth_getTransactionReceipt") {
          const hash = params?.[0];
          insist(typeof hash === "string", "fixture_hash");
          state.queries.push(hash as Hex);
          state.mutate?.();
          if (state.receiptMissing) return null;
          const index = records.findIndex(
            (_, i) => logs(i)[0]!.transactionHash === hash,
          );
          if (index < 0) return null;
          const r = records[index]!,
            list = logs(index);
          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: fault === "receipt" ? h("b") : state.hash,
            blockNumber: `0x${r.block.toString(16)}`,
            from: state.from,
            to: profile.directory,
            contractAddress: null,
            cumulativeGasUsed: "0x1",
            gasUsed: "0x1",
            effectiveGasPrice: "0x1",
            logs: list,
            logsBloom: "0x" + "0".repeat(512),
            status: state.receiptStatus,
            type: "0x2",
          };
        }
        if (method === "eth_call") {
          const data = object(params?.[0]).data;
          insist(
            typeof data === "string" && /^0x[0-9a-f]+$/.test(data),
            "fixture_calldata",
          );
          const call = decodeFunctionData({ abi, data: data as Hex }),
            r = records.at(-1)!;
          state.contractReadBlocks.push([
            call.functionName,
            String(params?.[1]),
          ]);
          if (call.functionName === "getBinding")
            return encodeFunctionResult({
              abi,
              functionName: "getBinding",
              result: web2Binding(profile),
            });
          if (call.functionName === "getOrigin")
            return encodeFunctionResult({
              abi,
              functionName: "getOrigin",
              result: r.origin,
            });
          if (
            call.functionName === "isDiscoverable" ||
            call.functionName === "isWeb2Verified" ||
            call.functionName === "isHnsVerified"
          )
            return encodeFunctionResult({
              abi,
              functionName: call.functionName,
              result:
                call.functionName === "isWeb2Verified"
                  ? state.web2VerifiedAtBlock
                  : call.functionName === "isHnsVerified"
                    ? state.hnsVerifiedAtBlock
                    : state.listed &&
                      (state.web2VerifiedAtBlock || state.hnsVerifiedAtBlock),
            });
          if (call.functionName === "getWeb2Verification")
            return encodeFunctionResult({
              abi,
              functionName: "getWeb2Verification",
              result: [
                1n,
                {
                  originRevision: r.origin.revision,
                  controllerRevision: r.origin.controllerRevision,
                  observedAt: 65536n,
                  validUntil: state.web2ValidUntil,
                  evidenceSha256: h("7"),
                },
              ],
            });
          if (call.functionName === "getHnsAttachment")
            return encodeFunctionResult({
              abi,
              functionName: "getHnsAttachment",
              result: [
                state.hnsValidUntil === 0n ? 0n : 1n,
                {
                  registry: a("2"),
                  namespaceId: h("8"),
                  namespaceAuthorizationHash: h("9"),
                  namespaceAuthorizationRevision: 1n,
                  controllerRevision: r.origin.controllerRevision,
                  hnsHeight: 1n,
                  hnsBlockHash: h("c"),
                  observedAt: 65536n,
                  validUntil: state.hnsValidUntil,
                  evidenceSha256: h("6"),
                },
              ],
            });
          if (call.functionName === "getCommunity")
            return encodeFunctionResult({
              abi,
              functionName: "getCommunity",
              result: {
                registry: a("0"),
                tldHash: h("0"),
                configurationRevision: BigInt(count),
                configuration: r.chainConfig,
                verificationRevision: 0n,
                verification: {
                  configurationRevision: 0n,
                  hnsHeight: 0n,
                  hnsBlockHash: h("0"),
                  observedAt: 0n,
                  validUntil: 0n,
                  evidenceSha256: h("0"),
                },
                listingRevision: 1n,
                listed: state.listed,
              },
            });
        }
        throw new Error("unexpected simulated RPC " + method);
      },
    }),
  });
  return {
    config,
    profile,
    records,
    state,
    client,
    // Deliberately tiny fixture-only freshness budget, never a live default.
    policy: { now: () => state.now, maxSafeBlockAgeSeconds: 100n },
    transport: async (request: Request) =>
      new Response(
        records.find((r) => request.url.includes(r.pin.uri.slice(7)))!.bytes,
      ),
  };
}
