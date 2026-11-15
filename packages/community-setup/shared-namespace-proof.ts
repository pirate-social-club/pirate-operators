import type {Hex} from "viem";
import {hash as namespaceHash} from "../community-names/namespace-registry-adapter.ts";
import {namespaceBinding, bindingKey, type NamespaceAuthorityProof, type NamespaceBinding} from "../community-names/namespace-import.ts";
import {fields, requireLinux, hash, natural, text} from "./linux-input.ts";
// Exact Naming v3 projection; no ABI, HNS verifier or member issuer is implemented.
export function sharedNamespaceProofFrom(value: unknown): NamespaceAuthorityProof {
  const p = fields(value, ["id","binding","authorityKind","externalAuthorityId","evidenceDigest","onChainAuthorityRevision","onChainPolicyRevision","onChainScopeRevision","expiresAt","purpose","memberIssuance"]);
  const decimal = (v: unknown) => {
    const s = text(v, 20); requireLinux(/^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) <= 0xffffffffffffffffn, "namespace_revision", "Use exact current namespace revisions.");return s;
  };
  requireLinux(p.authorityKind === "hns_owner" || p.authorityKind === "hns_delegated_controller", "namespace_role", "Registry administration, Pirate governance and a hosting address do not prove external HNS control.");
  requireLinux(p.purpose === "bind_community_namespace" && p.memberIssuance === "separate_authorization_required", "namespace_purpose", "Operator binding grants no member claim or funding authority.");
  return {id: namespaceHash(p.id as string), binding: namespaceBinding(p.binding as NamespaceBinding), authorityKind:p.authorityKind,
    externalAuthorityId:namespaceHash(p.externalAuthorityId as string),evidenceDigest:namespaceHash(p.evidenceDigest as string),
    onChainAuthorityRevision:decimal(p.onChainAuthorityRevision),onChainPolicyRevision:decimal(p.onChainPolicyRevision),
    onChainScopeRevision:decimal(p.onChainScopeRevision),expiresAt:natural(p.expiresAt),
    purpose:"bind_community_namespace",memberIssuance:"separate_authorization_required"};
}
export function sameNamespaceAuthority(a: NamespaceAuthorityProof,b:NamespaceAuthorityProof) {
  return a.id === b.id && bindingKey(a.binding) === bindingKey(b.binding) && a.authorityKind === b.authorityKind &&
    a.externalAuthorityId === b.externalAuthorityId && a.evidenceDigest === b.evidenceDigest &&
    a.onChainAuthorityRevision === b.onChainAuthorityRevision && a.onChainPolicyRevision === b.onChainPolicyRevision &&
    a.onChainScopeRevision === b.onChainScopeRevision && a.purpose === b.purpose && a.memberIssuance === b.memberIssuance;
}
