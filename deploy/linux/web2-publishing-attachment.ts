import {
  canonical,
  exact,
  hashJson,
  insist,
  object,
  text,
} from "../../packages/community/common.ts";
import { validateOwnerGrant } from "../../packages/release/owner-grant.ts";
import { ownerAuthorizationRecord } from "../../packages/community/owner-authorization-typed-data.ts";
import type {
  ConfiguredGrantSelection,
  GrantAttachmentObservation,
  OwnerGrantScope,
  Web2PublishingAttachment,
} from "./web2-operator-inputs.ts";

export function configuredGrantSelection(
  value: ConfiguredGrantSelection,
  scope: OwnerGrantScope,
): ConfiguredGrantSelection {
  const v = structuredClone(value);
  exact(object(v), [
    "schema",
    "scope",
    "grant",
    "selectionDigest",
    "admissionReference",
  ]);
  const grant = validateOwnerGrant(v.grant),
    { selectionDigest, ...body } = v;
  insist(
    v.schema === "pirate.web2-configured-owner-grant/1" &&
      canonical(v.scope) === canonical(scope) &&
      canonical(grant) === canonical(v.grant) &&
      selectionDigest === hashJson(body) &&
      text(v.admissionReference, 1024).length > 0 &&
      grant.communityId === scope.communityId &&
      grant.communityOrigin === scope.origin &&
      grant.ownerWallet === scope.ownerWallet &&
      canonical(grant.policy) === canonical(scope.policy) &&
      grant.destination.chainId === scope.chainId &&
      grant.destination.postsContract === scope.postsContract &&
      grant.destination.publisher === scope.publisher,
    "web2_configured_grant_changed",
    409,
  );
  return v;
}
export function requireGrantObservation(
  observation: GrantAttachmentObservation,
  selection: ConfiguredGrantSelection,
) {
  exact(object(observation), [
    "selectionDigest",
    "grantDigest",
    "admissionReference",
    "state",
  ]);
  insist(
    observation.selectionDigest === selection.selectionDigest &&
      observation.grantDigest === selection.grant.sha256 &&
      observation.admissionReference === selection.admissionReference &&
      ["absent", "attached", "unknown"].includes(observation.state),
    "web2_managed_grant_admission_changed",
    409,
  );
  return observation;
}
/** Content validation only. The configured grant port must independently
 * authenticate and reconcile admission before this can enter an installation. */
export function publishingAttachment(value: Web2PublishingAttachment) {
  const v = structuredClone(value);
  exact(object(v), [
    "schema",
    "selection",
    "authorization",
    "custodyBindingDigest",
    "digest",
  ]);
  const selection = configuredGrantSelection(v.selection, v.selection.scope),
    signed = ownerAuthorizationRecord(v.authorization),
    a = signed.authorization,
    g = selection.grant,
    { digest, ...body } = v;
  insist(
    v.schema === "pirate.web2-publishing-attachment/1" &&
      digest === hashJson(body) &&
      /^0x[0-9a-f]{64}$/.test(v.custodyBindingDigest) &&
      canonical(signed) === canonical(v.authorization) &&
      a.schema === "pirate.owner-publishing-authorization/2" &&
      a.communityId === g.communityId &&
      a.ownerWallet === g.ownerWallet &&
      canonical(a.policy) === canonical(g.policy) &&
      a.validFrom === g.validFrom &&
      a.expiresAt === g.expiresAt,
    "web2_publishing_attachment_changed",
    409,
  );
  return v;
}
