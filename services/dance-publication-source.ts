import { keccak256, type Address, type PublicClient } from "viem";
import { canonical, hashText, insist } from "../packages/community/common.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import { danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { learningResultsV5Abi } from "../packages/protocol/generated/learning-results-v5.ts";
import { directoryV3Abi, validateWeb2Profile, web2Binding,
  type Web2DirectoryProfile } from "../packages/community/web2-directory.ts";
import { assertWeb2Origin, validateWeb2Configuration,
  type Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import type { Web2EligibilityPolicy } from "../packages/community/web2-directory-reader.ts";
import type { DancePublicationSelectionV2 } from "./dance-publication-checks.ts";

export interface DancePublicationSourceV2 extends DancePublicationSelectionV2 {
  capturePolicy: Address;
  capturePolicyRuntimeHash: `0x${string}`;
}
export async function verifyDancePublicationSource(input: {
  client: PublicClient; selected: DancePublicationSourceV2;
  profile: Web2DirectoryProfile; config: Web2CommunityConfig;
  caller: Address; owner: { epoch: bigint; wallet: Address };
  clock: Web2EligibilityPolicy; afterAwait(): Promise<void>;
}) {
  const { client, afterAwait } = input, now = input.clock.now, age = input.clock.maxSafeBlockAgeSeconds;
  insist(typeof afterAwait === "function", "dance_local_fence_required", 503);
  const { selected: s, profile, config, caller, owner } = structuredClone({
    selected: input.selected, profile: input.profile, config: input.config,
    caller: input.caller, owner: input.owner });
  const p = validateWeb2Profile(profile), c = validateWeb2Configuration(config, p);
  const d = s.domain, pin = s.pin, rpc = danceReadPort(client);
  insist(typeof now === "function" && typeof age === "bigint" && age >= 0n &&
    age < 2n ** 64n, "dance_freshness_required", 503);
  const chain = await rpc.chainId(); await afterAwait();
  insist(s.version === 2 && d.chainId === BigInt(p.chainId) &&
    d.communityId === p.communityId && pin.directory === p.directory &&
    pin.directoryRuntimeHash === p.directoryCodeHash &&
    c.learningRecords === pin.consentRegistry && c.postsContract === pin.posts &&
    danceSourceHash(d, pin) === s.sourceHash &&
    chain === p.chainId, "dance_source_changed", 503);
  let observedAt = now();
  insist(typeof observedAt === "bigint" && observedAt >= 0n, "dance_clock_invalid", 503);
  const a = await rpc.safe(); await afterAwait();
  insist(a.number >= pin.deploymentBlock && a.number >= p.deploymentBlock &&
    a.timestamp > 0n, "dance_source_unconfirmed", 503);
  const fresh = () => {
    const t = now();
    insist(typeof t === "bigint" && t >= observedAt && t >= a.timestamp && t - a.timestamp <= age,
      "dance_source_stale", 503);
    observedAt = t;
    return t;
  };
  fresh();
  const at = { blockHash: a.hash, requireCanonical: true as const };
  const v = { address: d.verifier, abi: danceVerdictsAbi, ...at } as const;
  const r = { address: pin.consentRegistry, abi: learningResultsV5Abi, ...at } as const;
  const q = { address: p.directory, abi: directoryV3Abi, args: [d.communityId], ...at } as const;
  const [version, hash, community, capture, captureHash, context, rv, cv, rc, rd, rh,
    row, binding, origin] = await Promise.all([
    client.readContract({ ...v, functionName: "VERSION" }),
    client.readContract({ ...v, functionName: "sourceHash" }),
    client.readContract({ ...v, functionName: "communityId" }),
    client.readContract({ ...v, functionName: "capturePolicy" }),
    client.readContract({ ...v, functionName: "capturePolicyRuntimeHash" }),
    client.readContract({ ...v, functionName: "ownerContext" }),
    client.readContract({ ...r, functionName: "VERSION" }),
    client.readContract({ ...r, functionName: "consentVersion" }),
    client.readContract({ ...r, functionName: "communityId" }),
    client.readContract({ ...r, functionName: "directory" }),
    client.readContract({ ...r, functionName: "directoryRuntimeHash" }),
    client.readContract({ ...q, functionName: "getCommunity" }),
    client.readContract({ ...q, functionName: "getBinding" }),
    client.readContract({ ...q, functionName: "getOrigin" }),
  ]);
  await afterAwait();
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  insist(version === 2 && hash === s.sourceHash && community === d.communityId &&
    eq(capture, s.capturePolicy) && captureHash === s.capturePolicyRuntimeHash &&
    rv === 5 && cv === 1 && rc === d.communityId && eq(rd, pin.directory) &&
    rh === pin.directoryRuntimeHash, "dance_runtime_source_changed", 503);
  const peers = [[d.verifier, pin.runtimeCodeHash], [pin.directory, pin.directoryRuntimeHash],
    [pin.posts, pin.postsRuntimeHash], [pin.consentRegistry, pin.consentRegistryRuntimeHash],
    [s.capturePolicy, s.capturePolicyRuntimeHash]] as const;
  const anchored = danceReadPort(client, a);
  const code = await Promise.all(peers.map(([address]) => anchored.code(address, a.number)));
  await afterAwait();
  insist(code.every((bytes, i) => bytes && bytes !== "0x" &&
    keccak256(bytes) === peers[i]![1]), "dance_runtime_changed", 503);
  insist(row.configurationRevision === BigInt(c.configurationRevision) &&
    row.configuration.sha256Digest === hashText(canonical(c)) &&
    eq(row.configuration.controller, c.controller) && eq(row.configuration.publisher, c.publisher) &&
    eq(caller, c.publisher) && eq(row.configuration.learningRecords, pin.consentRegistry) &&
    canonical(binding) === canonical(web2Binding(p)), "dance_directory_roles_changed", 409);
  assertWeb2Origin(c, origin);
  insist(owner.epoch > 0n && context[0] === owner.epoch &&
    context[1] === row.configurationRevision && eq(context[2], c.controller) &&
    eq(context[3], owner.wallet) && context[4] <= a.timestamp &&
    a.timestamp < context[5], "dance_owner_context_changed", 403);
  const finish = async () => {
    const [end, chain] = await Promise.all([rpc.block(a.number), rpc.chainId()]);
    await afterAwait();
    insist(chain === p.chainId && end.number === a.number && end.hash === a.hash &&
      end.timestamp === a.timestamp, "dance_publication_anchor_changed", 503);
    const now = fresh();
    insist(context[4] <= now && now < context[5], "dance_owner_context_expired", 403);
  };
  await finish();
  const safeUntilS = a.timestamp + age + 1n;
  const expiresAtS = context[5] < safeUntilS ? context[5] : safeUntilS;
  return { source: s, config: c, profile: p, anchor: a, at, owner: context, expiresAtS, finish };
}
