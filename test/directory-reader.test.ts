import { defaultContentProfile } from "../packages/moderation/content-profile.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
} from "viem";
import { canonical, hashText } from "../packages/community/common.ts";
import {
  communityId,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../packages/community/manifest-core.ts";
import {
  directoryAbi,
  readConfiguration,
} from "../packages/community/directory-reader.ts";
import { preparePin } from "../packages/community/ipfs.ts";

const addr = (s: string) => `0x${s.repeat(40)}` as const,
  hash = (s: string) => `0x${s.repeat(64)}` as const;
async function fixture(fault = "") {
  const config = {
    schema: "pirate.community-config/2",
    chainId: 31337,
    directory: addr("1"),
    registry: addr("2"),
    communityId: communityId(31337, addr("2")),
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
      contentProfile: defaultContentProfile,
    recognitionSigner: addr("6"),
      moderationSigner: addr("6"),
    },
    publisherRevocations: [] as {
      postsContract: string;
      publisher: string;
      fromBlock: string;
    }[],
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
  const { chainConfig, pin } = records.at(-1)!;
  let blocks = 0;
  // Explicit RPC fixture tests reader logic; live chain qualification is separate.
  const client = createPublicClient({
    transport: custom({
      async request({ method }) {
        switch (method) {
          case "eth_chainId":
            return fault === "chain" ? "0x1" : "0x7a69";
          case "eth_blockNumber":
            return "0x64";
          case "eth_getCode":
            return code;
          case "eth_getBlockByNumber":
            return {
              number: "0x63",
              hash: fault === "reorg" && blocks++ ? hash("b") : hash("a"),
              parentHash: hash("c"),
              timestamp: "0x6b49d200",
              transactions: [],
            };
          case "eth_getLogs":
            return records.map((record, index) => ({
              address: config.directory,
              blockHash: hash("a"),
              blockNumber: `0x${(51 + index).toString(16)}`,
              data: encodeAbiParameters(
                directoryAbi[1].inputs.filter(
                  (input) => !("indexed" in input && input.indexed),
                ),
                [
                  BigInt(index + 1),
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
              logIndex: "0x0",
              transactionHash: hash("d"),
              transactionIndex: "0x0",
              removed: false,
            }));
          case "eth_call":
            return encodeFunctionResult({
              abi: directoryAbi,
              functionName: "getCommunity",
              result: {
                registry: config.registry,
                tldHash: hashText(config.tld),
                configurationRevision: BigInt(records.length),
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
          default:
            throw new Error("unexpected fixture RPC method:" + method);
        }
      },
    }),
  });
  return {
    config,
    read: () =>
      readConfiguration(
        client,
        {
          chainId: 31337,
          directory: config.directory,
          registry: config.registry,
          communityId: config.communityId,
          deploymentBlock: 50n,
          directoryCodeHash: keccak256(code),
        },
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
test("canonical directory reader binds event history, raw manifest bytes, current state and block hash", async () => {
  const f = await fixture();
  assert.deepEqual(await f.read(), f.config);
  for (const fault of ["chain", "manifest", "state", "bytes", "reorg"])
    await assert.rejects((await fixture(fault)).read());
});

test("correctly committed pretty or duplicate-key configuration bytes are refused", async () => {
  for (const fault of ["pretty", "duplicates"])
    await assert.rejects(
      (await fixture(fault)).read(),
      /configuration_not_canonical/,
    );
});
test("a revocation cutoff future at its publication does not become valid at a later read head", async () => {
  await assert.rejects(
    (await fixture("cutoff")).read(),
    /invalid_revocation_block/,
  );
});
