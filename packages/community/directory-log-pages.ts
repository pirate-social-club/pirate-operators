import type { PublicClient } from "viem";
import { insist } from "./common.ts";
import { directoryAbi } from "./directory-wire.ts";
import { CONFIGURATION_PAGE_SIZE } from "./directory-checkpoint.ts";
import type { AnyDirectoryProfile, ConfigurationLog } from "./directory-reader.ts";

// Dense RPC ranges are bisected. A single block is indivisible to getLogs, but
// processing and durable writes still use fixed-size pages, including many
// revisions in the same block. No lifetime revision or publication-count cap.
export async function* configurationLogPages(client: PublicClient, profile: AnyDirectoryProfile,
  from: bigint, through: bigint): AsyncGenerator<ConfigurationLog[]> {
  async function* range(first: bigint, last: bigint): AsyncGenerator<ConfigurationLog[]> {
    const logs = await client.getLogs({ address: profile.directory, event: directoryAbi[1],
      args: { communityId: profile.communityId }, fromBlock: first, toBlock: last, strict: true });
    if (logs.length > 64 && first < last) {
      const mid = (first + last) / 2n;
      yield* range(first, mid);
      yield* range(mid + 1n, last);
      return;
    }
    for (const log of logs) insist(log.removed !== true, "removed_configuration_event", 503);
    logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    for (let offset = 0; offset < logs.length; offset += CONFIGURATION_PAGE_SIZE)
      yield logs.slice(offset, offset + CONFIGURATION_PAGE_SIZE);
  }
  for (let first = from; first <= through; first += 10000n)
    yield* range(first, first + 9999n < through ? first + 9999n : through);
}
