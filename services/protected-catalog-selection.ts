import type { Hex, PublicClient } from "viem";
import type { NativePostsChain, NativePostsChainPolicy } from "../deploy/linux/web2-native-posts-chain.ts";
import { amount, bytes32, canonical, hashJson, insist } from "../packages/community/common.ts";
import { fetchPublicIpfs, type IpfsTransport } from "../packages/community/ipfs.ts";
import { address, decimal, ipfsUri } from "../packages/community/manifest-core.ts";
import { catalogOwner } from "../packages/community/owner-policy.ts";
import { validatePostForEvent } from "../packages/community/post-manifest.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { recognitionAuthority, type RecognitionAuthority } from "../packages/recognition/authorization.ts";
import { acceptedIntent, recognitionProfile, reservationId, type AcceptedIntent } from "../packages/recognition/intent.ts";
import type { ProtectedCatalogSelection } from "../packages/recognition/protected-catalog.ts";
import { readNativePostsPublicationReference, readNativePostsQuote } from "./native-posts-publication.ts";

interface AdmittedProtectedOriginal extends Omit<ProtectedCatalogSelection, "publisher" | "postsContract" | "recognition" | "readCanonical"> {
  configuration: Web2CommunityConfig;
  intentSha256: Hex;
  recordingId: Hex;
}

export type ProtectedCatalogOriginalSelection =
  | { kind: "legacy" }
  | { kind: "protected"; original: Readonly<AdmittedProtectedOriginal> };

/** The installed source authenticates the retained original and proof authority.
 * Only an explicit legacy selection allows the receiver's legacy path. */
export function createProtectedCatalogSelector(input: {
  readAdmittedOriginal(authority: RecognitionAuthority, intent: AcceptedIntent):
    Promise<Readonly<ProtectedCatalogOriginalSelection> | null>;
  client: Pick<PublicClient, "getBlock">;
  readCanonicalOriginal: NativePostsChain["readCanonicalOriginal"];
  limits: Readonly<Pick<NativePostsChainPolicy, "maximumSafeAgeSeconds" | "maximumTotalFee">>;
  ipfs: IpfsTransport;
}) {
  const limits = Object.freeze({ ...input.limits });
  insist(limits.maximumSafeAgeSeconds > 0n && limits.maximumTotalFee > 0n, "protected_catalog_fee_policy_unavailable", 503);
  return async (authority: RecognitionAuthority, intent: AcceptedIntent): Promise<ProtectedCatalogSelection | null> => {
    const a = recognitionAuthority(authority), p = acceptedIntent(intent);
    const admitted = await input.readAdmittedOriginal(a, p);
    insist(admitted, "protected_catalog_selection_unavailable", 503);
    if (admitted.kind === "legacy") return null;
    const selected = structuredClone(admitted.original);
    const config = selected.configuration;
    const reference = readNativePostsPublicationReference(canonical(selected.reference));
    const quote = readNativePostsQuote(canonical({ reference: hashJson(reference), result: selected.quote }), reference);
    const recognition = recognitionProfile(config.policies.recognition);
    const publisher = address(config.publisher), postsContract = address(config.postsContract);
    const proofSigner = address(selected.proofSigner);
    const applicationOriginalSha256 = bytes32(selected.applicationOriginalSha256);
    const grantSha256 = bytes32(selected.grantSha256);
    const retainedCustodySha256 = bytes32(selected.retainedCustodySha256);
    const recordingId = bytes32(selected.recordingId);
    const intentSha256 = hashJson(p);
    const publication = Object.freeze({
      communityId: bytes32(selected.publication.communityId),
      postId: bytes32(selected.publication.postId),
      authorId: bytes32(selected.publication.authorId),
      configurationRevision: selected.publication.configurationRevision,
      manifestSha256: bytes32(selected.publication.manifestSha256),
      manifestURI: ipfsUri(selected.publication.manifestURI),
    });
    insist(a.enabled && config.schema === "pirate.community-config/4" && config.chainId === 6343 &&
      config.configurationRevision === 1 && catalogOwner(config.policies.admission) &&
      config.communityId === a.communityId && a.communityId === p.communityId &&
      config.app.origin === a.communityOrigin && a.communityOrigin === p.communityOrigin &&
      config.configurationRevision === a.configurationRevision && a.configurationRevision === p.configurationRevision &&
      recognition.namespace === a.namespace && a.namespace === p.namespace &&
      recognition.sha256 === a.profileSha256 && a.profileSha256 === p.profileSha256 && publisher === a.publisher &&
      proofSigner !== publisher && proofSigner !== recognition.signer &&
      reference.installationId === config.installationId && reference.jobId === p.jobId &&
      selected.intentSha256 === intentSha256 &&
      publication.communityId === p.communityId && publication.postId === p.postId &&
      publication.configurationRevision === p.configurationRevision && p.publicationRevision === 1,
    "protected_catalog_original_changed", 409);
    const maximumFee = amount(quote.maximumFeeWei);
    insist(maximumFee <= limits.maximumTotalFee, "protected_catalog_fee_policy_changed", 409);

    const readCanonical: ProtectedCatalogSelection["readCanonical"] = async (hash) => {
      const transactionHash = bytes32(hash);
      const receipt = await input.readCanonicalOriginal(publication, transactionHash, maximumFee);
      if (!receipt) return { state: "unavailable" };
      const fee = amount(receipt.actualFeeWei);
      insist(receipt.transactionHash === transactionHash && fee > 0n && fee <= maximumFee, "protected_catalog_receipt_changed", 409);
      if (receipt.state === "reverted") return { state: "reverted" };
      insist(receipt.postId === publication.postId && receipt.revision === 1, "protected_catalog_receipt_changed", 409);

      const { bytes } = await fetchPublicIpfs(publication.manifestURI, publication.manifestSha256, 1024 * 1024, input.ipfs);
      const manifest = validatePostForEvent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        { ...publication, chainId: 6343, postsContract, kind: 0, revision: 1 }, config);
      const audio = manifest.media.find(({ role }) => role === "audio");
      insist(audio?.sha256 === p.audioSha256 && audio.byteLength === p.audioBytes &&
        manifest.terms?.revision === p.termsRevision && manifest.terms.allowsDerivatives === p.allowsDerivatives &&
        hashJson(manifest.terms) === p.termsSha256 && manifest.recognition?.intentSha256 === intentSha256 &&
        manifest.recognition.reservationId === reservationId(p) && manifest.recognition.recordingId === recordingId,
      "protected_catalog_manifest_changed", 409);
      const blockNumber = BigInt(decimal(receipt.blockNumber));
      const [block, safe] = await Promise.all([
        input.client.getBlock({ blockNumber, includeTransactions: false }),
        input.client.getBlock({ blockTag: "safe", includeTransactions: false }),
      ]);
      const now = BigInt(Date.now());
      insist(block.number === blockNumber && block.hash === receipt.blockHash &&
        safe.number !== null && safe.number >= blockNumber && safe.hash && safe.timestamp * 1000n <= now &&
        now < (safe.timestamp + limits.maximumSafeAgeSeconds) * 1000n,
      "protected_catalog_receipt_not_safe", 503);
      return receipt;
    };

    return Object.freeze({
      reference, applicationOriginalSha256, grantSha256, retainedCustodySha256, quote, publisher,
      postsContract, proofSigner, publication, recognition, readCanonical,
    });
  };
}
