import { decodeEventLog, keccak256, type Hex, type PublicClient } from "viem";
import { canonical, hashText, insist, object } from "./common.ts";
import { fetchPublicIpfs, type IpfsTransport } from "./ipfs.ts";
import {
  authenticateConfigurationLog,
  type ConfigurationLog,
} from "./directory-reader.ts";
import { configurationLogPages } from "./directory-log-pages.ts";
import {
  directoryV3Abi,
  validateWeb2Profile,
  web2Binding,
  type Web2DirectoryProfile,
} from "./web2-directory.ts";
import {
  advanceWeb2Configuration,
  assertWeb2Origin,
  validateWeb2Configuration,
  web2ConfigurationState,
} from "./web2-config-manifest.ts";
import { sharedBytes32 } from "./shared-identity.ts";

// Explicit V3 cold reader. Bounded pages, no lifetime cap, no V1/V2 cache/schema
// fallback. Existing caches stay untouched until separately versioned adoption.
export async function readWeb2Community(
  client: PublicClient,
  profile: Web2DirectoryProfile,
  send?: IpfsTransport,
) {
  const p = validateWeb2Profile(profile);
  insist(
    (await client.getChainId()) === p.chainId,
    "wrong_application_chain",
    503,
  );
  const safe = await client.getBlock({ blockTag: "safe" });
  insist(
    typeof safe.number === "bigint" && safe.number >= p.deploymentBlock,
    "directory_not_confirmed",
    503,
  );
  const through = safe.number,
    safeHash = sharedBytes32(safe.hash);
  const request = {
    address: p.directory,
    abi: directoryV3Abi,
    args: [p.communityId],
    blockNumber: through,
  } as const;
  const [code, row, binding, origin, discoverable, web2Verified, hnsVerified] =
    await Promise.all([
      client.getCode({ address: p.directory, blockNumber: through }),
      client.readContract({ ...request, functionName: "getCommunity" }),
      client.readContract({ ...request, functionName: "getBinding" }),
      client.readContract({ ...request, functionName: "getOrigin" }),
      client.readContract({ ...request, functionName: "isDiscoverable" }),
      client.readContract({ ...request, functionName: "isWeb2Verified" }),
      client.readContract({ ...request, functionName: "isHnsVerified" }),
    ]);
  insist(
    code &&
      keccak256(code) === p.directoryCodeHash &&
      canonical(binding) === canonical(web2Binding(p)),
    "directory_binding_changed",
    503,
  );
  insist(
    row.configurationRevision > 0n &&
      row.configurationRevision <= BigInt(Number.MAX_SAFE_INTEGER),
    "invalid_directory_configuration",
    503,
  );
  const state = web2ConfigurationState();
  let last: ConfigurationLog | undefined;
  for await (const page of configurationLogPages(
    client,
    p,
    p.deploymentBlock,
    through,
  ))
    for (const log of page) {
      insist(
        log.args.communityId === p.communityId &&
          log.args.revision ===
            BigInt((state.last?.configurationRevision ?? 0) + 1) &&
          log.blockNumber >= p.deploymentBlock &&
          log.blockNumber <= through &&
          (!last ||
            log.blockNumber > last.blockNumber ||
            (log.blockNumber === last.blockNumber &&
              log.logIndex > last.logIndex)),
        "configuration_history_conflict",
        503,
      );
      const [receipt, historicalCode] = await Promise.all([
        authenticateConfigurationLog(client, p, log),
        client.getCode({ address: p.directory, blockNumber: log.blockNumber }),
      ]);
      insist(
        historicalCode && keccak256(historicalCode) === p.directoryCodeHash,
        "directory_code_changed",
        503,
      );
      const { bytes } = await fetchPublicIpfs(
        log.args.uri,
        log.args.sha256Digest,
        65536,
        send,
      );
      const document = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes),
        raw = object(JSON.parse(document));
      insist(document === canonical(raw), "configuration_not_canonical", 503);
      const c = validateWeb2Configuration(raw, p),
        a = log.args;
      insist(
        c.configurationRevision === Number(a.revision) &&
          c.controller === a.controller.toLowerCase() &&
          c.publisher === a.publisher.toLowerCase() &&
          c.operatorPayments === a.operatorPayments.toLowerCase() &&
          c.learningRecords === a.learningRecords.toLowerCase(),
        "configuration_event_mismatch",
        503,
      );
      const origins: { sha256Digest: Hex }[] = [];
      for (const event of receipt.logs) {
        if (event.address.toLowerCase() !== p.directory) continue;
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: directoryV3Abi,
            eventName: "OriginConfigured",
            data: event.data,
            topics: event.topics,
            strict: true,
          });
        } catch {
          continue;
        }
        if (
          decoded.args.communityId !== p.communityId ||
          decoded.args.configurationRevision !== a.revision
        )
          continue;
        insist(
          event.removed !== true &&
            event.blockHash === log.blockHash &&
            event.transactionHash === log.transactionHash &&
            event.blockNumber === log.blockNumber,
          "origin_event_provenance_changed",
          503,
        );
        origins.push(decoded.args.origin);
      }
      insist(origins.length === 1, "origin_configuration_event_missing", 503);
      // This catches origin changes hidden in an ordinary configure or transfer.
      assertWeb2Origin(c, origins[0]!);
      advanceWeb2Configuration(state, c, log.blockNumber);
      last = log;
    }
  insist(
    state.last &&
      last &&
      BigInt(state.last.configurationRevision) === row.configurationRevision,
    "configuration_history_missing",
    503,
  );
  const current = row.configuration,
    event = last.args;
  insist(
    current.sha256Digest === event.sha256Digest &&
      current.uri === event.uri &&
      current.controller.toLowerCase() === state.last.controller &&
      current.publisher.toLowerCase() === state.last.publisher &&
      current.operatorPayments.toLowerCase() === state.last.operatorPayments &&
      current.learningRecords.toLowerCase() === state.last.learningRecords &&
      hashText(canonical(state.last)) === current.sha256Digest,
    "directory_state_event_mismatch",
    503,
  );
  assertWeb2Origin(state.last, origin);
  insist(
    (await client.getBlock({ blockNumber: through })).hash === safeHash,
    "directory_chain_reorganized",
    503,
  );
  return {
    config: state.last,
    origin,
    discoverable,
    web2Verified,
    hnsVerified,
    blockNumber: through,
    blockHash: safeHash,
  };
}
