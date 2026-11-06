import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { canonical, hashText, insist, object } from "./common.ts";
import { validateConfig, type CommunityConfig } from "./config-manifest.ts";
import { communityId } from "./manifest-core.ts";
import { fetchPublicIpfs, type IpfsTransport } from "./ipfs.ts";

// Exact V1 wire fields from ICommunityDirectoryV1; no discovery status is used
// as publication or moderation authority.
export const directoryAbi = parseAbi([
  "function getCommunity(bytes32 communityId) view returns ((address registry,bytes32 tldHash,uint64 configurationRevision,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration,uint64 verificationRevision,(uint64 configurationRevision,uint64 hnsHeight,bytes32 hnsBlockHash,uint64 observedAt,uint64 validUntil,bytes32 evidenceSha256) verification,uint64 listingRevision,bool listed))",
  "event ConfigurationPublished(bytes32 indexed communityId,uint64 revision,address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri)",
  "function registerCommunity(address registry,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration) returns (bytes32 communityId)",
]);
export interface DirectoryProfile {
  chainId: 6343 | 31337;
  directory: Address;
  registry: Address;
  communityId: Hex;
  deploymentBlock: bigint;
  directoryCodeHash: Hex;
}
export async function readConfigurationHistory(
  client: PublicClient,
  profile: DirectoryProfile,
  send?: IpfsTransport,
): Promise<CommunityConfig[]> {
  insist(
    (await client.getChainId()) === profile.chainId,
    "wrong_application_chain",
    503,
  );
  insist(
    communityId(profile.chainId, profile.registry) === profile.communityId,
    "wrong_directory_profile",
    503,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head >= profile.deploymentBlock + 1n, "directory_not_confirmed", 503);
  const blockNumber = head - 1n,
    block = await client.getBlock({ blockNumber });
  const code = await client.getCode({
    address: profile.directory,
    blockNumber,
  });
  const { keccak256 } = await import("viem");
  insist(
    code && keccak256(code) === profile.directoryCodeHash,
    "directory_code_changed",
    503,
  );
  const row = await client.readContract({
    address: profile.directory,
    abi: directoryAbi,
    functionName: "getCommunity",
    args: [profile.communityId],
    blockNumber,
  });
  insist(
    row.registry.toLowerCase() === profile.registry &&
      row.configurationRevision > 0n &&
      row.configurationRevision <= 256n,
    "invalid_directory_configuration",
    503,
  );
  const logs = [];
  for (
    let fromBlock = profile.deploymentBlock;
    fromBlock <= blockNumber;
    fromBlock += 10000n
  ) {
    logs.push(
      ...(await client.getLogs({
        address: profile.directory,
        event: directoryAbi[1],
        args: { communityId: profile.communityId },
        fromBlock,
        toBlock:
          fromBlock + 9999n < blockNumber ? fromBlock + 9999n : blockNumber,
        strict: true,
      })),
    );
  }
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  insist(
    logs.length === Number(row.configurationRevision),
    "configuration_history_missing",
    503,
  );
  const history: CommunityConfig[] = [];
  for (const log of logs) {
    const event = log.args;
    insist(
      event.revision === BigInt(history.length + 1),
      "configuration_history_conflict",
      503,
    );
    const { bytes } = await fetchPublicIpfs(
      event.uri,
      event.sha256Digest,
      65536,
      send,
    );
    const decoded = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
      raw = object(JSON.parse(decoded));
    insist(decoded === canonical(raw), "configuration_not_canonical", 503);
    const config = validateConfig(raw, history, log.blockNumber);
    insist(
      config.chainId === profile.chainId &&
        config.communityId === profile.communityId &&
        config.registry === profile.registry &&
        config.directory === profile.directory &&
        config.configurationRevision === Number(event.revision) &&
        config.controller === event.controller.toLowerCase() &&
        config.publisher === event.publisher.toLowerCase() &&
        config.operatorPayments === event.operatorPayments.toLowerCase() &&
        config.learningRecords === event.learningRecords.toLowerCase() &&
        hashText(config.tld) === row.tldHash,
      "configuration_event_mismatch",
      503,
    );
    history.push(config);
  }
  const last = logs.at(-1)!.args,
    current = row.configuration;
  insist(
    last.sha256Digest === current.sha256Digest &&
      last.uri === current.uri &&
      last.controller.toLowerCase() === current.controller.toLowerCase() &&
      last.publisher.toLowerCase() === current.publisher.toLowerCase() &&
      last.operatorPayments.toLowerCase() ===
        current.operatorPayments.toLowerCase() &&
      last.learningRecords.toLowerCase() ===
        current.learningRecords.toLowerCase(),
    "directory_state_event_mismatch",
    503,
  );
  insist(
    (await client.getBlock({ blockNumber })).hash === block.hash,
    "directory_chain_reorganized",
    503,
  );
  return history;
}

export async function readConfiguration(client: PublicClient, profile: DirectoryProfile, send?: IpfsTransport): Promise<CommunityConfig> {
  return (await readConfigurationHistory(client, profile, send)).at(-1)!;
}
