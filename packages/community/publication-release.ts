import type { Address, PublicClient } from "viem";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  hashText,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import { ipfsUri } from "./manifest-core.ts";
import { fetchPublicIpfs, publicGateways, type IpfsTransport } from "./ipfs.ts";
import { managedRequest, type ManagedClient } from "./managed-client.ts";
import type { PublicationInput } from "./publication-input.ts";
import { observeRootRegistration } from "./registration-chain.ts";
import { validatePost, validateRegistration } from "./post-manifest.ts";
import { pinOperationId, type ReleaseRole } from "../release/artifacts.ts";
import { ownerReleaseKey } from "../release/owner-release.ts";
import type { OwnerBudgetGrant } from "../release/owner-grant.ts";
import type { RetainedPin } from "../release/pin-operations.ts";
import type { OperationResult, Reconciliation } from "./publication.ts";

export interface ReleasePorts {
  client: ManagedClient;
  grantHash: string;
  /** Registered releases only. Absent under the unregistered owner policy. */
  registrationOperator?: Address;
  story?: PublicClient;
  /** Present only under the unregistered owner policy. */
  ownerGrant?: OwnerBudgetGrant;
  ipfs?: IpfsTransport;
}
/** Pin operation identity: per release key for owner jobs, per grant otherwise. */
const releasePinId = (
  input: PublicationInput,
  ports: ReleasePorts,
  role: ReleaseRole,
) =>
  pinOperationId(
    ports.ownerGrant
      ? ownerReleaseKey(ports.ownerGrant, input.job.job_id)
      : ports.grantHash,
    role,
  );
function validatedPin(value: unknown): RetainedPin {
  const p = object(value);
  const gateway = publicGateways.find((g) => g === p.gateway);
  exact(p, [
    "uri",
    "sha256",
    "byteLength",
    "mediaType",
    "retained",
    "gateway",
    "verifiedAt",
  ]);
  insist(
    p.retained === true &&
      (p.mediaType === "audio/mpeg" || p.mediaType === "application/json") &&
      gateway,
    "invalid_retained_pin",
    503,
  );
  return {
    uri: ipfsUri(p.uri),
    sha256: bytes32(p.sha256),
    byteLength: integer(p.byteLength, 1, 25 * 1024 * 1024),
    mediaType: p.mediaType,
    retained: true,
    gateway,
    verifiedAt: integer(p.verifiedAt, 1, Math.floor(Date.now() / 1000)),
  };
}
async function response(
  ports: ReleasePorts,
  path: string,
  action: Parameters<typeof managedRequest>[2],
  body: Record<string, unknown>,
  operationId: string,
) {
  const reply = await managedRequest(ports.client, path, action, body);
  if (reply.status === 404 && reply.body.state === "absent")
    return { state: "absent" };
  insist(
    reply.body.schema === "pirate.managed-release-operation/1" &&
      reply.body.operationId === operationId &&
      reply.body.grantSha256 === ports.grantHash,
    "release_response_scope_mismatch",
    503,
  );
  return object(reply.body.result);
}
export async function releasePin(
  input: PublicationInput,
  ports: ReleasePorts,
  role: ReleaseRole,
  mode: "execute" | "reconcile",
): Promise<Reconciliation> {
  const id = releasePinId(input, ports, role),
    value = await response(
      ports,
      "/v1/releases/pin" + (mode === "reconcile" ? "/status" : ""),
      mode === "reconcile" ? "release_pin_status" : "release_pin",
      { context: input.context, role },
      id,
    );
  if (value.state === "absent")
    return {
      kind: "absent",
      proof: canonical({
        service: ports.client.origin,
        operationId: id,
        grantHash: ports.grantHash,
        state: "absent",
      }),
    };
  if (value.state !== "confirmed") return { kind: "unknown" };
  const pin = validatedPin(value.pin);
  return { kind: "confirmed", providerId: pin.uri, value: { pin } };
}
async function metadata(
  input: PublicationInput,
  ports: ReleasePorts,
  pin: RetainedPin,
  nft: RetainedPin,
) {
  const { bytes } = await fetchPublicIpfs(
      pin.uri,
      pin.sha256,
      pin.byteLength,
      ports.ipfs,
    ),
    o = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  exact(o, [
    "schema_version",
    "title",
    "createdAt",
    "creators",
    "external_url",
    "chainId",
    "postsContract",
    "communityId",
    "postId",
    "authorId",
    "description",
    "mediaUrl",
    "mediaHash",
    "mediaType",
    "lyrics",
    "lineage",
  ]);
  const creator = object(
      Array.isArray(o.creators) && o.creators.length === 1
        ? o.creators[0]
        : null,
    ),
    lineage = object(o.lineage);
  exact(creator, ["name", "address", "contributionPercent"]);
  exact(lineage, ["kind"]);
  const audio = validatedPin(object(input.progress.pin_audio).pin),
    createdAt = Number(o.createdAt);
  insist(
    o.schema_version === "pirate-community-data-metadata/1" &&
      o.title === input.metadata.title &&
      o.chainId === 6343 &&
      o.postsContract === ports.client.configuration.postsContract &&
      o.communityId === ports.client.configuration.communityId &&
      o.postId === input.context.postId &&
      o.authorId === input.context.authorId &&
      o.external_url === ports.client.configuration.app.origin + "/" &&
      o.mediaUrl === audio.uri &&
      o.mediaHash === input.row.audio_sha256 &&
      o.mediaType === "audio/mpeg" &&
      o.lyrics === input.metadata.lyrics.sourceText &&
      lineage.kind === "root" &&
      creator.name === input.context.authorId &&
      creator.address === input.context.recipient &&
      creator.contributionPercent === 100 &&
      String(createdAt) === o.createdAt &&
      Number.isSafeInteger(createdAt) &&
      createdAt >= Math.floor(input.createdAt / 1000) &&
      createdAt <= Math.floor(Date.now() / 1000),
    "registration_metadata_input_mismatch",
    503,
  );
  const nftBytes = await fetchPublicIpfs(
      nft.uri,
      nft.sha256,
      nft.byteLength,
      ports.ipfs,
    ),
    n = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(nftBytes.bytes),
      ),
    );
  insist(
    n.title === o.title &&
      n.name === o.title &&
      n.createdAt === o.createdAt &&
      n.postId === o.postId &&
      n.authorId === o.authorId &&
      canonical(n.creators) === canonical(o.creators) &&
      n.animation_url === o.mediaUrl,
    "registration_nft_metadata_input_mismatch",
    503,
  );
  return createdAt;
}
export async function releaseRegistration(
  input: PublicationInput,
  ports: ReleasePorts,
  mode: "execute" | "reconcile",
): Promise<Reconciliation> {
  const pins: RetainedPin[] = [];
  for (const role of ["ip_metadata", "nft_metadata"] as const) {
    const result = await releasePin(input, ports, role, mode);
    if (result.kind !== "confirmed") return result;
    pins.push(validatedPin(result.value.pin));
  }
  const [ip, nft] = pins as [RetainedPin, RetainedPin],
    createdAt = await metadata(input, ports, ip, nft),
    id = hashJson({ grantHash: ports.grantHash, kind: "root_registration" });
  const result = await response(
    ports,
    "/v1/releases/register" + (mode === "reconcile" ? "/status" : ""),
    mode === "reconcile" ? "release_register_status" : "release_register",
    { context: input.context },
    id,
  );
  if (result.state === "absent")
    return {
      kind: "absent",
      proof: canonical({
        service: ports.client.origin,
        operationId: id,
        grantHash: ports.grantHash,
        state: "absent",
      }),
    };
  if (result.state !== "confirmed") return { kind: "unknown" };
  insist(
    ports.story && ports.registrationOperator,
    "registration_not_applicable",
    409,
  );
  const receipt = validateRegistration(result.receipt),
    actual = await observeRootRegistration(
      ports.story,
      receipt.transactionHash,
      ports.registrationOperator,
      {
        recipient: input.context.recipient as Address,
        contentSha256: input.row.audio_sha256 as `0x${string}`,
        metadata: { uri: ip.uri, sha256: ip.sha256 },
        nftMetadata: { uri: nft.uri, sha256: nft.sha256 },
      },
    );
  insist(
    actual && canonical(actual) === canonical(receipt),
    "registration_not_independently_confirmed",
    503,
  );
  return {
    kind: "confirmed",
    providerId: receipt.transactionHash,
    value: {
      receipt,
      metadata: ip,
      nftMetadata: nft,
      metadataCreatedAt: createdAt,
    },
  };
}
export async function validateReleaseResult(
  input: PublicationInput,
  ports: ReleasePorts,
  step: "pin_audio" | "pin_lyrics" | "pin_manifest" | "registration",
  result: OperationResult,
) {
  insist(result.kind === "confirmed", "invalid_release_outcome", 503);
  if (step === "registration") {
    insist(
      !ports.ownerGrant && ports.story && ports.registrationOperator,
      "registration_not_applicable",
      409,
    );
    const receipt = validateRegistration(result.value.receipt),
      ip = validatedPin(result.value.metadata),
      nft = validatedPin(result.value.nftMetadata),
      createdAt = await metadata(input, ports, ip, nft);
    const actual = await observeRootRegistration(
      ports.story!,
      receipt.transactionHash,
      ports.registrationOperator!,
      {
        recipient: input.context.recipient as Address,
        contentSha256: input.row.audio_sha256 as `0x${string}`,
        metadata: { uri: ip.uri, sha256: ip.sha256 },
        nftMetadata: { uri: nft.uri, sha256: nft.sha256 },
      },
    );
    insist(
      actual &&
        canonical(actual) === canonical(receipt) &&
        result.providerId === receipt.transactionHash &&
        result.value.metadataCreatedAt === createdAt,
      "registration_result_mismatch",
      503,
    );
    return;
  }
  const pin = validatedPin(result.value.pin),
    { bytes } = await fetchPublicIpfs(
      pin.uri,
      pin.sha256,
      pin.byteLength,
      ports.ipfs,
    );
  insist(
    bytes.length === pin.byteLength && result.providerId === pin.uri,
    "release_pin_result_mismatch",
    503,
  );
  if (step === "pin_audio")
    insist(
      pin.mediaType === "audio/mpeg" &&
        pin.sha256 === input.row.audio_sha256 &&
        pin.byteLength === input.row.audio_bytes,
      "audio_pin_input_mismatch",
      503,
    );
  else if (step === "pin_lyrics")
    insist(
      pin.mediaType === "application/json" &&
        hashText(canonical(input.metadata.lyrics)) === pin.sha256 &&
        new TextDecoder("utf-8", { fatal: true }).decode(bytes) ===
          canonical(input.metadata.lyrics),
      "lyrics_pin_input_mismatch",
      503,
    );
  else {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const post = validatePost(JSON.parse(decoded));
    insist(
      decoded === canonical(post) && hashJson(post) === pin.sha256,
      "post_manifest_not_canonical",
      503,
    );
    const audio = validatedPin(object(input.progress.pin_audio).pin),
      lyrics = validatedPin(object(input.progress.pin_lyrics).pin),
      owner = !!ports.ownerGrant,
      // Owner jobs never register; publishedAt is the managed admission time.
      registration = owner ? null : object(input.progress.registration),
      admission = object(input.progress.admission),
      decision = object(admission.decision),
      created = Math.floor(input.createdAt / 1000);
    insist(
      owner
        ? post.schema === "pirate.community-post/3" &&
            canonical(post.registration) ===
              canonical({ status: "absent", reason: "deferred_for_launch" }) &&
            post.publishedAt >= created &&
            post.publishedAt <= Math.floor(Date.now() / 1000)
        : post.schema !== "pirate.community-post/3" &&
            post.publishedAt === registration!.metadataCreatedAt &&
            canonical(post.registration) === canonical(registration!.receipt),
      "post_manifest_registration_mismatch",
      503,
    );
    insist(
      post.chainId === 6343 &&
        post.postsContract === ports.client.configuration.postsContract &&
        post.communityId === ports.client.configuration.communityId &&
        post.postId === input.context.postId &&
        post.authorId === input.context.authorId &&
        post.title === input.metadata.title &&
        post.language === input.metadata.language &&
        post.revision === 1 &&
        post.configurationRevision ===
          ports.client.configuration.configurationRevision &&
        post.admission.evidenceSha256 === admission.evidenceSha256 &&
        post.rating ===
          (decision.rating === "adult_18" ? "adult" : "general") &&
        canonical(post.media) ===
          canonical(
            [
              { role: "audio", ...audio },
              { role: "lyrics", ...lyrics },
            ].map(({ role, uri, sha256, byteLength, mediaType }) => ({
              role,
              uri,
              sha256,
              byteLength,
              mediaType,
            })),
          ),
      "post_manifest_input_mismatch",
      503,
    );
  }
}
