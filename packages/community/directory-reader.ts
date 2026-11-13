import { decodeEventLog, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { canonical, hashText, insist, object } from "./common.ts";
import { configurationState, validateConfiguration, type LegacyCommunityConfig, type DirectoryConfig, type SharedCommunityConfig } from "./config-manifest.ts";
import { communityId } from "./manifest-core.ts";
import { fetchPublicIpfs, type IpfsTransport } from "./ipfs.ts";
import { directoryAbi } from "./directory-wire.ts";
import { configurationLogPages } from "./directory-log-pages.ts";
import { sharedBinding, sharedDirectoryAbi, validateSharedProfile, type SharedDirectoryProfile } from "./shared-directory.ts";
import { validateSharedConfig } from "./shared-config-manifest.ts";
import { CONFIGURATION_PAGE_SIZE, type ConfigurationEvidence, type DirectoryHistoryCache } from "./directory-checkpoint.ts";
export { directoryAbi } from "./directory-wire.ts";
export type { DirectoryCheckpoint, DirectoryHistoryCache } from "./directory-checkpoint.ts";

export interface DirectoryProfile {
  chainId: 6343 | 31337;
  directory: Address;
  registry: Address;
  communityId: Hex;
  deploymentBlock: bigint;
  directoryCodeHash: Hex;
}
export type AnyDirectoryProfile = DirectoryProfile | SharedDirectoryProfile;
export function isSharedProfile(p: AnyDirectoryProfile): p is SharedDirectoryProfile {
  return "schema" in p && p.schema === "pirate.shared-directory/2";
}
export interface ConfigurationLog {
  args: { communityId: Hex; revision: bigint; controller: Address; publisher: Address;
    operatorPayments: Address; learningRecords: Address; sha256Digest: Hex; uri: string };
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}
// RPC event objects contain transport metadata beyond the authenticated log.
// Compare every declared event/provenance field in an owned canonical shape.
const comparable = (log: ConfigurationLog) => canonical({
  args: {
    communityId: log.args.communityId,
    revision: String(log.args.revision),
    controller: log.args.controller.toLowerCase(),
    publisher: log.args.publisher.toLowerCase(),
    operatorPayments: log.args.operatorPayments.toLowerCase(),
    learningRecords: log.args.learningRecords.toLowerCase(),
    sha256Digest: log.args.sha256Digest,
    uri: log.args.uri,
  },
  blockNumber: String(log.blockNumber),
  blockHash: log.blockHash,
  transactionHash: log.transactionHash,
  logIndex: log.logIndex,
});

export async function authenticateConfigurationLog(client: PublicClient, profile: AnyDirectoryProfile, log: ConfigurationLog) {
  const [receipt, block] = await Promise.all([
    client.getTransactionReceipt({ hash: log.transactionHash }), client.getBlock({ blockNumber: log.blockNumber }),
  ]);
  insist(receipt.status === "success" && receipt.transactionHash === log.transactionHash &&
    receipt.blockHash === log.blockHash && block.hash === log.blockHash && receipt.blockNumber === log.blockNumber,
    "directory_cache_provenance_changed", 503);
  const matching: ConfigurationLog[] = [];
  for (const event of receipt.logs) {
    if (event.address.toLowerCase() !== profile.directory.toLowerCase() || event.logIndex !== log.logIndex) continue;
    let args;
    try { args = decodeEventLog({ abi: directoryAbi, eventName: "ConfigurationPublished", data: event.data,
      topics: event.topics, strict: true }).args; } catch { continue; }
    insist(event.blockHash === log.blockHash && event.blockNumber === log.blockNumber &&
      event.transactionHash === log.transactionHash && event.logIndex !== null && event.removed !== true,
      "directory_cache_event_changed", 503);
    matching.push({ args, blockNumber: event.blockNumber, blockHash: event.blockHash,
      transactionHash: event.transactionHash, logIndex: event.logIndex });
  }
  insist(matching.length === 1 && comparable(matching[0]!) === comparable(log), "directory_cache_event_changed", 503);
}

// Returns a current configuration without materializing lifetime history. A caller
// explicitly requesting history may collect the staged stream via onConfiguration.
// The callback must not commit side effects: final state/reorg checks can still fail.
export async function walkConfigurationHistory(client: PublicClient, profile: AnyDirectoryProfile,
  send?: IpfsTransport, cache?: DirectoryHistoryCache, onConfiguration?: (config: DirectoryConfig) => void): Promise<DirectoryConfig> {
  insist((await client.getChainId()) === profile.chainId, "wrong_application_chain", 503);
  if (isSharedProfile(profile)) validateSharedProfile(profile);
  else insist(!("schema" in profile) && communityId(profile.chainId, profile.registry) === profile.communityId, "wrong_directory_profile", 503);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > profile.deploymentBlock, "directory_not_confirmed", 503);
  const through = head - 1n;
  const [block, code, row, saved] = await Promise.all([
    client.getBlock({ blockNumber: through }), client.getCode({ address: profile.directory, blockNumber: through }),
    client.readContract({ address: profile.directory, abi: directoryAbi, functionName: "getCommunity",
      args: [profile.communityId], blockNumber: through }), cache?.load(through),
  ]);
  insist(block.hash && code && keccak256(code) === profile.directoryCodeHash, "directory_code_changed", 503);
  insist(row.registry.toLowerCase() === profile.registry && row.configurationRevision > 0n &&
    row.configurationRevision <= BigInt(Number.MAX_SAFE_INTEGER), "invalid_directory_configuration", 503);
  if (isSharedProfile(profile)) {
    const [binding, registryCode] = await Promise.all([
      client.readContract({ address: profile.directory, abi: sharedDirectoryAbi, functionName: "getBinding",
        args: [profile.communityId], blockNumber: through }),
      client.getCode({ address: profile.registry, blockNumber: through }),
    ]);
    insist(canonical(binding) === canonical(sharedBinding(profile)) && registryCode &&
      keccak256(registryCode) === profile.registryCodeHash, "shared_binding_changed", 503);
  }
  const state = configurationState(), writer = cache && (!saved || through + 1n > saved.nextBlock) ? cache.begin(saved) : undefined;
  let lastLog: ConfigurationLog | undefined, pending: ConfigurationEvidence[] = [];
  async function consume(log: ConfigurationLog, stored?: string) {
    insist(log.args.communityId === profile.communityId && log.args.revision === BigInt((state.last?.configurationRevision ?? 0) + 1) &&
      log.blockNumber >= profile.deploymentBlock && log.blockNumber <= through &&
      (!lastLog || log.blockNumber > lastLog.blockNumber ||
        (log.blockNumber === lastLog.blockNumber && log.logIndex > lastLog.logIndex)), "configuration_history_conflict", 503);
    await authenticateConfigurationLog(client, profile, log);
    const transport: IpfsTransport | undefined = stored === undefined ? send : async () => new Response(stored);
    const { bytes } = await fetchPublicIpfs(log.args.uri, log.args.sha256Digest, 65536, transport);
    const document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const raw = object(JSON.parse(document));
    insist(document === canonical(raw), "configuration_not_canonical", 503);
    const config = isSharedProfile(profile) ? validateSharedConfig(raw, profile, state, log.blockNumber)
      : validateConfiguration(raw, state, log.blockNumber);
    insist((isSharedProfile(profile) || config.schema === "pirate.community-config/1") &&
      config.chainId === profile.chainId && config.communityId === profile.communityId &&
      config.registry === profile.registry && config.directory === profile.directory &&
      config.configurationRevision === Number(log.args.revision) && config.controller === log.args.controller.toLowerCase() &&
      config.publisher === log.args.publisher.toLowerCase() && config.operatorPayments === log.args.operatorPayments.toLowerCase() &&
      config.learningRecords === log.args.learningRecords.toLowerCase() && hashText(config.tld) === row.tldHash,
      "configuration_event_mismatch", 503);
    lastLog = log;
    onConfiguration?.(config);
    pending.push({ log, document });
    if (pending.length === CONFIGURATION_PAGE_SIZE) { await writer?.append(pending); pending = []; }
  }
  if (saved) {
    insist(saved.nextBlock <= through + 1n && saved.revision <= Number(row.configurationRevision), "directory_cache_cursor_invalid", 503);
    for await (const page of cache!.pages(saved)) for (const item of page) {
      insist(item.log.blockNumber < saved.nextBlock, "directory_cache_cursor_invalid", 503);
      await consume(item.log, item.document);
    }
    insist(state.last?.configurationRevision === saved.revision, "directory_cache_history_invalid", 503);
  }
  // A pinned unchanged revision proves there was no new publication. Otherwise
  // scan only the uncheckpointed suffix, with bounded RPC ranges and page writes.
  const start = state.last?.configurationRevision === Number(row.configurationRevision) ? through + 1n
    : (saved?.nextBlock ?? profile.deploymentBlock);
  for await (const page of configurationLogPages(client, profile, start, through))
    for (const log of page) await consume(log);
  insist(state.last && lastLog && BigInt(state.last.configurationRevision) === row.configurationRevision,
    "configuration_history_missing", 503);
  const event = lastLog.args, current = row.configuration;
  insist(event.sha256Digest === current.sha256Digest && event.uri === current.uri &&
    event.controller.toLowerCase() === current.controller.toLowerCase() && event.publisher.toLowerCase() === current.publisher.toLowerCase() &&
    event.operatorPayments.toLowerCase() === current.operatorPayments.toLowerCase() &&
    event.learningRecords.toLowerCase() === current.learningRecords.toLowerCase(), "directory_state_event_mismatch", 503);
  insist((await client.getBlock({ blockNumber: through })).hash === block.hash, "directory_chain_reorganized", 503);
  if (pending.length) await writer?.append(pending);
  await writer?.commit(through, block.hash, state.last.configurationRevision);
  return state.last;
}

export function readConfigurationHistory(client: PublicClient, profile: SharedDirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache): Promise<SharedCommunityConfig[]>;
export function readConfigurationHistory(client: PublicClient, profile: DirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache): Promise<LegacyCommunityConfig[]>;
export async function readConfigurationHistory(client: PublicClient, profile: AnyDirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache): Promise<DirectoryConfig[]> {
  const history: DirectoryConfig[] = [];
  await walkConfigurationHistory(client, profile, send, cache, (config) => history.push(config));
  return history;
}
export function readConfiguration(client: PublicClient, profile: SharedDirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache): Promise<SharedCommunityConfig>;
export function readConfiguration(client: PublicClient, profile: DirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache): Promise<LegacyCommunityConfig>;
export function readConfiguration(client: PublicClient, profile: AnyDirectoryProfile, send?: IpfsTransport, cache?: DirectoryHistoryCache) {
  return walkConfigurationHistory(client, profile, send, cache);
}
