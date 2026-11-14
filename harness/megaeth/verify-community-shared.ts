import type { PublicClient } from "viem";
import { readConfiguration } from "../../packages/community/directory-reader.ts";
import { validateSharedProfile, type SharedDirectoryProfile } from "../../packages/community/shared-directory.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";
import type { DirectoryHistoryCache } from "../../packages/community/directory-checkpoint.ts";

export async function verifySharedCommunity(client: PublicClient, profile: SharedDirectoryProfile, transport?: IpfsTransport,
  cache?: DirectoryHistoryCache) {
  // Keep the verified identity and returned identity on the same owned snapshot.
  const exact = Object.freeze(validateSharedProfile(profile));
  const config = await readConfiguration(client, exact, transport, cache);
  // HNS freshness, name-holder state and free-claim policy must be checked by
  // Naming against the accepted registry SDK; directory proof cannot replace it.
  return { profile: exact, config, directoryVerified: true as const, issuanceAuthorized: false as const };
}
