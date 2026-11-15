import {
  decodeEventLog,
  keccak256,
  type Address,
  type ContractFunctionReturnType,
  type Hex,
  type PublicClient,
} from "viem";
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
  type Web2CommunityConfig,
} from "./web2-config-manifest.ts";
import { sharedBytes32 } from "./shared-identity.ts";

type Web2Lease = ContractFunctionReturnType<
  typeof directoryV3Abi,
  "view",
  "getWeb2Verification"
>;
type HnsLease = ContractFunctionReturnType<
  typeof directoryV3Abi,
  "view",
  "getHnsAttachment"
>;

interface ProofAuthoritySnapshot {
  readonly verifier: Address;
  readonly generation: bigint;
  readonly invalidatedAt: bigint;
}

export interface Web2EligibilityPolicy {
  /** Trusted service Unix-seconds clock, sampled again after all reads. */
  now: () => bigint;
  /** Explicit service policy, not a refresh interval or an implicit live default. */
  maxSafeBlockAgeSeconds: bigint;
}

export interface Web2VerificationSnapshot {
  readonly schema: "pirate.directory-verification-snapshot/2";
  readonly profile: Readonly<Web2DirectoryProfile>;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestamp: bigint;
  readonly capturedAt: bigint;
  readonly listedAtBlock: boolean;
  readonly listingRevision: bigint;
  readonly discoverableAtBlock: boolean;
  readonly web2: Readonly<{
    verifiedAtBlock: boolean;
    revision: bigint;
    acceptedGeneration: bigint;
    authority: Readonly<ProofAuthoritySnapshot>;
    proof: Web2Lease[1];
  }>;
  readonly hns: Readonly<{
    verifiedAtBlock: boolean;
    revision: bigint;
    acceptedGeneration: bigint;
    authority: Readonly<ProofAuthoritySnapshot>;
    proof: HnsLease[1];
  }>;
}

function currentProofAuthority(
  acceptedGeneration: bigint,
  observedAt: bigint,
  authority: ProofAuthoritySnapshot,
) {
  return (
    acceptedGeneration === authority.generation &&
    (authority.generation === 1n || observedAt > authority.invalidatedAt)
  );
}

function queryTime(value: unknown): asserts value is bigint {
  insist(
    typeof value === "bigint" && value >= 0n,
    "invalid_directory_query_time",
  );
}
function maximumSafeAge(value: unknown): asserts value is bigint {
  insist(
    typeof value === "bigint" && value >= 0n && value < 2n ** 64n,
    "explicit_directory_freshness_policy_required",
  );
}

/** Re-evaluate an authenticated in-process snapshot at each use. This does not
 * authenticate serialized/untrusted cache input or prove changes after its block. */
export function evaluateWeb2Eligibility(
  snapshot: Web2VerificationSnapshot,
  evaluatedAt: bigint,
  maxSafeBlockAgeSeconds: bigint,
) {
  queryTime(evaluatedAt);
  maximumSafeAge(maxSafeBlockAgeSeconds);
  if (
    evaluatedAt < snapshot.capturedAt ||
    evaluatedAt < snapshot.blockTimestamp
  ) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "query_clock_behind_snapshot" as const,
      evaluatedAt,
    });
  }
  const safeBlockAgeSeconds = evaluatedAt - snapshot.blockTimestamp;
  if (safeBlockAgeSeconds > maxSafeBlockAgeSeconds) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "safe_block_stale" as const,
      evaluatedAt,
      safeBlockAgeSeconds,
    });
  }
  const web2Verified =
    snapshot.web2.verifiedAtBlock &&
    currentProofAuthority(
      snapshot.web2.acceptedGeneration,
      snapshot.web2.proof.observedAt,
      snapshot.web2.authority,
    ) &&
    evaluatedAt < snapshot.web2.proof.validUntil;
  const hnsVerified =
    snapshot.hns.verifiedAtBlock &&
    currentProofAuthority(
      snapshot.hns.acceptedGeneration,
      snapshot.hns.proof.observedAt,
      snapshot.hns.authority,
    ) &&
    evaluatedAt < snapshot.hns.proof.validUntil;
  return Object.freeze({
    status: "available" as const,
    evaluatedAt,
    safeBlockAgeSeconds,
    web2Verified,
    hnsVerified,
    discoverable: snapshot.listedAtBlock && (web2Verified || hnsVerified),
  });
}

// Explicit V3 cold reader. Bounded pages, no lifetime cap, no V1/V2 cache/schema
// fallback. Existing caches stay untouched until separately versioned adoption.
export async function readWeb2Community(
  client: PublicClient,
  profile: Web2DirectoryProfile,
  policy: Web2EligibilityPolicy,
  send?: IpfsTransport,
) {
  const p = validateWeb2Profile(profile);
  // Own the policy before awaits; a concurrent caller cannot replace it midway.
  const now = policy?.now,
    maxSafeBlockAgeSeconds = policy?.maxSafeBlockAgeSeconds;
  insist(typeof now === "function", "explicit_directory_query_clock_required");
  maximumSafeAge(maxSafeBlockAgeSeconds);
  const startedAt = now();
  queryTime(startedAt);
  insist(
    (await client.getChainId()) === p.chainId,
    "wrong_application_chain",
    503,
  );
  const safe = await client.getBlock({ blockTag: "safe" });
  insist(
    typeof safe.number === "bigint" &&
      safe.number >= p.deploymentBlock &&
      typeof safe.timestamp === "bigint" &&
      safe.timestamp >= 0n,
    "directory_not_confirmed",
    503,
  );
  const through = safe.number,
    safeHash = sharedBytes32(safe.hash),
    blockTimestamp = safe.timestamp;
  const request = {
    address: p.directory,
    abi: directoryV3Abi,
    args: [p.communityId],
    blockNumber: through,
  } as const;
  const authorityRequest = {
    address: p.directory,
    abi: directoryV3Abi,
    blockNumber: through,
  } as const;
  const [
    code,
    row,
    binding,
    origin,
    discoverable,
    web2Verified,
    hnsVerified,
    web2Lease,
    hnsLease,
    web2AuthorityRow,
    hnsAuthorityRow,
    web2AcceptedGeneration,
    hnsAcceptedGeneration,
  ] = await Promise.all([
    client.getCode({ address: p.directory, blockNumber: through }),
    client.readContract({ ...request, functionName: "getCommunity" }),
    client.readContract({ ...request, functionName: "getBinding" }),
    client.readContract({ ...request, functionName: "getOrigin" }),
    client.readContract({ ...request, functionName: "isDiscoverable" }),
    client.readContract({ ...request, functionName: "isWeb2Verified" }),
    client.readContract({ ...request, functionName: "isHnsVerified" }),
    client.readContract({ ...request, functionName: "getWeb2Verification" }),
    client.readContract({ ...request, functionName: "getHnsAttachment" }),
    client.readContract({
      ...authorityRequest,
      functionName: "getWeb2ProofAuthority",
    }),
    client.readContract({
      ...authorityRequest,
      functionName: "getHnsProofAuthority",
    }),
    client.readContract({ ...request, functionName: "getWeb2ProofGeneration" }),
    client.readContract({ ...request, functionName: "getHnsProofGeneration" }),
  ]);
  const web2Authority = Object.freeze({
    verifier: web2AuthorityRow[0],
    generation: web2AuthorityRow[1],
    invalidatedAt: web2AuthorityRow[2],
  });
  const hnsAuthority = Object.freeze({
    verifier: hnsAuthorityRow[0],
    generation: hnsAuthorityRow[1],
    invalidatedAt: hnsAuthorityRow[2],
  });
  insist(
    code &&
      keccak256(code) === p.directoryCodeHash &&
      canonical(binding) === canonical(web2Binding(p)),
    "directory_binding_changed",
    503,
  );
  insist(
    web2Authority.generation > 0n &&
      hnsAuthority.generation > 0n &&
      web2Authority.invalidatedAt <= blockTimestamp &&
      hnsAuthority.invalidatedAt <= blockTimestamp &&
      web2AcceptedGeneration <= web2Authority.generation &&
      hnsAcceptedGeneration <= hnsAuthority.generation &&
      discoverable === (row.listed && (web2Verified || hnsVerified)) &&
      (!web2Verified ||
        (web2Lease[0] > 0n &&
          currentProofAuthority(
            web2AcceptedGeneration,
            web2Lease[1].observedAt,
            web2Authority,
          ) &&
          web2Lease[1].observedAt <= blockTimestamp &&
          blockTimestamp < web2Lease[1].validUntil)) &&
      (!hnsVerified ||
        (hnsLease[0] > 0n &&
          currentProofAuthority(
            hnsAcceptedGeneration,
            hnsLease[1].observedAt,
            hnsAuthority,
          ) &&
          hnsLease[1].observedAt <= blockTimestamp &&
          blockTimestamp < hnsLease[1].validUntil)),
    "directory_verification_snapshot_mismatch",
    503,
  );
  insist(
    row.configurationRevision > 0n &&
      row.configurationRevision <= BigInt(Number.MAX_SAFE_INTEGER),
    "invalid_directory_configuration",
    503,
  );
  const state = web2ConfigurationState();
  const history: Web2CommunityConfig[] = [];
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
      history.push(c);
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
  const confirmation = await client.getBlock({ blockNumber: through });
  insist(
    confirmation.number === through &&
      confirmation.hash === safeHash &&
      confirmation.timestamp === blockTimestamp,
    "directory_chain_reorganized",
    503,
  );
  const capturedAt = now();
  queryTime(capturedAt);
  insist(capturedAt >= startedAt, "directory_query_clock_regressed", 503);
  const verificationSnapshot: Web2VerificationSnapshot = Object.freeze({
    schema: "pirate.directory-verification-snapshot/2",
    profile: p,
    blockNumber: through,
    blockHash: safeHash,
    blockTimestamp,
    capturedAt,
    listedAtBlock: row.listed,
    listingRevision: row.listingRevision,
    discoverableAtBlock: discoverable,
    web2: Object.freeze({
      verifiedAtBlock: web2Verified,
      revision: web2Lease[0],
      acceptedGeneration: web2AcceptedGeneration,
      authority: web2Authority,
      proof: Object.freeze({ ...web2Lease[1] }),
    }),
    hns: Object.freeze({
      verifiedAtBlock: hnsVerified,
      revision: hnsLease[0],
      acceptedGeneration: hnsAcceptedGeneration,
      authority: hnsAuthority,
      proof: Object.freeze({ ...hnsLease[1] }),
    }),
  });
  return {
    config: state.last,
    history: Object.freeze(history.map((c) => structuredClone(c))),
    origin,
    verificationSnapshot,
    eligibility: evaluateWeb2Eligibility(
      verificationSnapshot,
      capturedAt,
      maxSafeBlockAgeSeconds,
    ),
    blockNumber: through,
    blockHash: safeHash,
  };
}
