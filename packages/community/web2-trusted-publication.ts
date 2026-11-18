import { canonical, exact, insist, object } from "./common.ts";
import { nativeDigest, verifyNativeRecord } from "./native-business-binding.ts";
import type { Web2CommunityConfig } from "./web2-config-manifest.ts";
import type { Web2NativeOriginal } from "./web2-native-business-binding.ts";
import { consentDigest } from "../protocol/publication-consent.ts";
import type { SignedRecord } from "../../deploy/linux/installed-records.ts";
import type { Web2NativePublicationGraph, Web2NativePublicationInitialization } from "../../deploy/linux/web2-publication-selection.ts";
import { parsePublicationRelease, publicationSelectionHash } from "../../services/publication-app-selection.ts";

export const maxTrustedWeb2PublicationBytes = 5 * 1024 ** 2;
export const trustedWeb2PublicationFile = "web2-trusted-revision-two-publication.json";
export const trustedWeb2PublicationInitializationBinding = "WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON";
export const trustedWeb2PublicationExpiryBinding = "WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS";
export const trustedWeb2PublicationReadbackPath = "/_operator/readback/publication-selection";

export interface Web2TrustedPublicationAttachment {
  schema: "pirate.web2-trusted-revision-two-publication/1";
  nativeOriginalSha256: string;
  graphSha256: string;
  approvalSha256: string;
  initialization: Web2NativePublicationInitialization;
}

interface TrustedPublicationAuthority {
  graphSha256: string;
  approvalSha256: string;
  registryRuntimeHash: string;
  configuration: Web2CommunityConfig;
  ownerWallet: string;
  transport: Web2NativePublicationGraph;
}

/** Both the host and the private initializer check the signed attachment. The
 * host additionally supplies the independently verified rev2 approval. */
export async function verifyTrustedWeb2Publication(
  raw: string, original: Web2NativeOriginal, approved?: TrustedPublicationAuthority,
) {
  insist(typeof raw === "string" && raw.length <= maxTrustedWeb2PublicationBytes &&
    new TextEncoder().encode(raw).byteLength <= maxTrustedWeb2PublicationBytes,
    "trusted_web2_publication_attachment_size", 503);
  const signed: SignedRecord<Web2TrustedPublicationAttachment> = JSON.parse(raw);
  insist(canonical(signed) === raw, "trusted_web2_publication_attachment_not_canonical", 503);
  await verifyNativeRecord(signed, original.trust);
  const body = signed.body;
  exact(object(body), ["schema", "nativeOriginalSha256", "graphSha256", "approvalSha256", "initialization"]);
  insist(body.schema === "pirate.web2-trusted-revision-two-publication/1" &&
    body.nativeOriginalSha256 === nativeDigest(original) &&
    typeof body.graphSha256 === "string" && /^[0-9a-f]{64}(?![\s\S])/.test(body.graphSha256) &&
    typeof body.approvalSha256 === "string" && /^[0-9a-f]{64}(?![\s\S])/.test(body.approvalSha256),
    "trusted_web2_publication_original_changed", 503);
  const { initialization } = body;
  exact(object(initialization), ["schema", "selector", "selection"]);
  const { selector, selection } = initialization;
  insist(initialization.schema === "pirate.web2-native-publication-initialization/1" &&
    selection?.schema === "pirate.publication-installation/1" && selection.previous === null &&
    selection.incarnation === "1" && Array.isArray(selection.entries) && selection.entries.length === 1,
    "trusted_web2_publication_initial_selection_required", 503);
  await verifyNativeRecord(selector, original.trust);
  const entry = selection.entries[0]!, release = parsePublicationRelease(entry.release);
  const draft = original.record.body.draft, { configuration } = release;
  insist(consentDigest(selection.active) === publicationSelectionHash(release) &&
    configuration.configurationRevision === 2 && draft.configuration.configurationRevision === 1 &&
    canonical({ ...configuration, configurationRevision: 1, learningRecords: draft.configuration.learningRecords }) ===
      canonical(draft.configuration) && configuration.learningRecords !== draft.configuration.learningRecords &&
    release.source.registry === configuration.learningRecords &&
    release.issuer !== draft.configuration.controller && release.issuer !== release.operator &&
    release.operator === draft.configuration.publisher &&
    release.fee.payer === release.operator && draft.configuration.controller !== draft.configuration.publisher &&
    entry.transportRef === selector.body.transportRef && selector.body.issuerAddress === release.issuer &&
    Object.keys(release.policies).sort().join(",") === "dance-review-attribution,dance-verdict",
    "trusted_web2_publication_active_release_changed", 503);
  if (approved) {
    insist(body.graphSha256 === approved.graphSha256 && body.approvalSha256 === approved.approvalSha256 &&
      canonical(configuration) === canonical(approved.configuration) && release.issuer !== approved.ownerWallet &&
      release.source.registryRuntimeHash === approved.registryRuntimeHash &&
      entry.transportRef === approved.transport.transportRef &&
      selector.body.issuerCapabilityRef === approved.transport.issuerCapabilityRef &&
      release.issuer === approved.transport.issuerAddress && release.operator === approved.transport.operatorAddress,
      "trusted_web2_publication_approval_changed", 503);
  }
  return { body, initialization, release, attachmentSha256: nativeDigest(signed) };
}
