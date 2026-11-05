import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { encodeFunctionData, parseAbi } from "viem";
import {
  hashJson,
  hashText,
  canonical,
  insist,
} from "../../packages/community/common.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import {
  OWNER_POLICY_VERSION,
  OWNER_POLICY_HASH,
} from "../../packages/community/owner-policy.ts";
import { preparePin } from "../../packages/community/ipfs.ts";

export const configureAbi = parseAbi([
  "function configure(bytes32 communityId,uint64 expectedRevision,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration)",
]);
export async function curatedConfigurationPlan() {
  const original = JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.configuration.json",
        "utf8",
      ),
    ),
    previous = validateConfig(original.configuration),
    manifest = validateConfig(
      {
        ...previous,
        configurationRevision: 2,
        policies: {
          ...previous.policies,
          admission: {
            version: OWNER_POLICY_VERSION,
            sha256: OWNER_POLICY_HASH,
          },
        },
      },
      [previous],
    ),
    bytes = new TextEncoder().encode(canonical(manifest)),
    pin = await preparePin(bytes, "application/json");
  insist(
    previous.communityId ===
      "0xd3f69af98a60cbebb54e77b4306115cfcd8f33d122da9d02e782972a6debea0f" &&
      previous.configurationRevision === 1,
    "curated_configuration_wrong_community",
    409,
  );
  const call = {
    to: manifest.directory,
    data: encodeFunctionData({
      abi: configureAbi,
      functionName: "configure",
      args: [
        manifest.communityId,
        1n,
        {
          controller: manifest.controller,
          publisher: manifest.publisher,
          operatorPayments: manifest.operatorPayments,
          learningRecords: manifest.learningRecords,
          sha256Digest: pin.sha256,
          uri: pin.uri,
        },
      ],
    }),
    gas: 1000000n,
  };
  const graph = await build({
      entryPoints: ["harness/megaeth/curated-configuration.ts"],
      bundle: true,
      write: false,
      platform: "node",
      packages: "external",
      metafile: true,
      logLevel: "silent",
    }),
    paths = [
      ...new Set([
        ...Object.keys(graph.metafile!.inputs),
        "docs/deployments/first-song-managed-20261105.configuration.json",
        "docs/deployments/first-song-managed-20261105.contracts.json",
        "docs/owner-curated-policy.json",
        "package.json",
        "package-lock.json",
      ]),
    ]
      .filter((p) => !p.includes("node_modules/"))
      .sort(),
    sourceHashes = Object.fromEntries(
      await Promise.all(
        paths.map(async (p) => [p, hashText(await readFile(p, "utf8"))]),
      ),
    );
  const profile = {
    schema: "pirate.owner-curated-configuration-plan/1",
    chainId: 6343,
    manifest,
    pin,
    originalConfigurationSha256: hashJson(previous),
    directoryProfile: original.profile.directoryProfile,
    transaction: {
      to: call.to,
      data: call.data,
      gas: call.gas.toString(),
      nonce: 18,
    },
    sourceHashes,
    credential: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      path: "/services/api-next",
      name: "FILEBASE_IPFS_TOKEN",
    },
    bounds: {
      pinAdds: 1,
      transactions: 1,
      maximumGasPrice: "30000000",
      maximumTotalFee: "30000000000000",
      executionSeconds: 900,
    },
    purpose:
      "Separate setup configuration pin and revision2. No song pin, registration, post, provider inference or credential creation.",
  };
  return {
    profile,
    profileHash: hashJson(profile),
    bytes,
    call,
    limits: {
      chainId: 6343 as const,
      maximumGasPrice: 30000000n,
      maximumTotalFee: 30000000000000n,
      maximumExecutionMs: 900000,
    },
  };
}
