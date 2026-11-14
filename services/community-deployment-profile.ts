import type { Address, Hex } from "viem";
import {parseSharedProfileDocument,sharedProfileDocument} from "../packages/community/shared-directory.ts";
import { bytes32, insist, object, text } from "../packages/community/common.ts";
import { address, communityId } from "../packages/community/manifest-core.ts";
import { publicGateways } from "../packages/community/ipfs.ts";

/** Server-owned deployment inputs; hosting origin supplies no naming authority. */
export interface CommunityDeploymentProfile {
  schema: "pirate.community-deployment/1";
  origin: string;
  name: string;
  planId: string;
  postingPeriod: string;
  rpcUrl: string;
  ipfsGateways: readonly string[];
  managedOrigin: string;
  creatorOrigin: string;
  directoryProfile: ReturnType<typeof sharedProfileDocument> | {
    chainId: 6343;
    communityId: Hex;
    registry: Address;
    directory: Address;
    directoryCodeHash: Hex;
    deploymentBlock: string;
  };
  posts: {
    address: Address;
    runtimeCodeHash: Hex;
    deploymentBlock: string;
  };
}

function fields(value: unknown, names: readonly string[]) {
  const row = object(value);
  insist(
    Object.keys(row).length === names.length &&
      names.every((name) => Object.hasOwn(row, name)),
    "invalid_community_deployment",
  );
  return row;
}

function endpoint(value: unknown, originOnly = false) {
  const input = text(value, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    insist(false, "invalid_community_deployment_endpoint");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url!.hostname);
  insist(
    (url!.protocol === "https:" || (url!.protocol === "http:" && local)) &&
      !url!.username && !url!.password && !url!.hash && !url!.search &&
      !/[\s\\]/.test(input) && input.startsWith(url!.origin) &&
      (!originOnly || input === url!.origin),
    "invalid_community_deployment_endpoint",
  );
  return input;
}

function origin(value: unknown) {
  const input = endpoint(value, true);
  insist(input.startsWith("https://"), "invalid_community_deployment_origin");
  return input;
}

function block(value: unknown) {
  insist(
    typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) &&
      BigInt(value) <= 0xffffffffffffffffn,
    "invalid_community_deployment_block",
  );
  return value;
}

export function validateCommunityDeploymentProfile(input: unknown): CommunityDeploymentProfile {
  const row = fields(input, ["schema", "origin", "name", "planId", "postingPeriod", "rpcUrl",
    "ipfsGateways", "managedOrigin", "creatorOrigin", "directoryProfile", "posts"]);
  insist(row.schema === "pirate.community-deployment/1", "invalid_community_deployment");
  const shared = object(row.directoryProfile).schema==="pirate.shared-directory/2";
  const sharedDirectory=shared?sharedProfileDocument(parseSharedProfileDocument(row.directoryProfile)):null;
  const directory = shared?object(sharedDirectory):fields(row.directoryProfile,
    ["chainId", "communityId", "registry", "directory", "directoryCodeHash", "deploymentBlock"]);
  const posts = fields(row.posts, ["address", "runtimeCodeHash", "deploymentBlock"]);
  insist(directory.chainId === 6343 || shared && directory.chainId === 31337, "wrong_application_chain");
  if(sharedDirectory)insist(sharedDirectory.hostingOrigin===origin(row.origin),"wrong_shared_hosting_origin");
  const registry = address(directory.registry), id = bytes32(directory.communityId);
  if(!shared)insist(communityId(6343, registry) === id, "wrong_directory_profile");
  const planId = text(row.planId, 64);
  insist(/^[a-f0-9]{64}$/.test(planId), "invalid_community_deployment_plan");
  const postingPeriod = text(row.postingPeriod, 100);
  insist(/^[a-z0-9][a-z0-9-]*$/.test(postingPeriod), "invalid_community_deployment_period");
  insist(Array.isArray(row.ipfsGateways) && row.ipfsGateways.length > 0 &&
    row.ipfsGateways.length <= publicGateways.length, "invalid_community_deployment_gateways");
  const gateways = row.ipfsGateways.map((value) => endpoint(value, true));
  insist(new Set(gateways).size === gateways.length, "invalid_community_deployment_gateways");
  return {
    schema: "pirate.community-deployment/1", origin: origin(row.origin),
    name: text(row.name, 100), planId, postingPeriod, rpcUrl: endpoint(row.rpcUrl),
    ipfsGateways: gateways, managedOrigin: origin(row.managedOrigin),
    creatorOrigin: origin(row.creatorOrigin),
    directoryProfile: sharedDirectory??{
      chainId: 6343, communityId: id, registry, directory: address(directory.directory),
      directoryCodeHash: bytes32(directory.directoryCodeHash),
      deploymentBlock: block(directory.deploymentBlock),
    },
    posts: { address: address(posts.address), runtimeCodeHash: bytes32(posts.runtimeCodeHash),
      deploymentBlock: block(posts.deploymentBlock) },
  };
}

export function readCommunityDeploymentProfile(value: string): CommunityDeploymentProfile {
  insist(typeof value === "string" && value.length <= 16384, "community_deployment_unconfigured", 503);
  return validateCommunityDeploymentProfile(JSON.parse(value));
}

/** The existing CID, digest, size and canonical-document checks remain upstream.
 * Only the configured public-content endpoint changes; no response is supplied here. */
export function communityIpfsTransport(deployment: CommunityDeploymentProfile) {
  return (request: Request) => {
    const url = new URL(request.url), index = publicGateways.indexOf(url.origin as typeof publicGateways[number]);
    insist(index >= 0 && url.pathname.startsWith("/ipfs/"), "unconfigured_public_content_endpoint", 503);
    const gateway = deployment.ipfsGateways[index % deployment.ipfsGateways.length]!;
    return fetch(new Request(new URL(url.pathname, gateway), request));
  };
}
