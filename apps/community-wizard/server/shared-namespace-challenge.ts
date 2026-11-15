// Validate the exact Naming-produced challenge projection; no proof or challenge
// issuance is implemented here. Retained expired challenges remain recoverable.
import {namespaceSelection,selectionKey,namespaceChallengeMessage} from "../../../packages/community-names/namespace-import.ts";
import {fields,requireLinux,natural,hash,reference,text} from "../../../packages/community-setup/shared-linux-profile.ts";
import type {NamespaceChallenge} from "./linux-contracts.ts";
export function namespaceChallengeFrom(value:unknown):NamespaceChallenge {
  const v=fields(value,["id","selectionKey","selection","purpose","authorityId","issuedAt","expiresAt","grantExpiresAt","policyId","message"]);
  const selection=namespaceSelection(v.selection as NamespaceChallenge["selection"]);
  const base={id:hash(v.id) as NamespaceChallenge["id"],selectionKey:hash(v.selectionKey) as NamespaceChallenge["selectionKey"],selection,
    purpose:"bind_community_namespace" as const,authorityId:hash(v.authorityId) as NamespaceChallenge["authorityId"],
    issuedAt:natural(v.issuedAt),expiresAt:natural(v.expiresAt),grantExpiresAt:natural(v.grantExpiresAt),policyId:reference(v.policyId)};
  requireLinux(v.purpose===base.purpose && base.selectionKey===selectionKey(selection) && base.expiresAt>base.issuedAt &&
    base.grantExpiresAt>=base.expiresAt && typeof v.message==="string" && v.message.length<=8192 &&
    v.message===namespaceChallengeMessage(base),"namespace_challenge","Retain the genuine one-use Naming challenge and exact original selection.");
  return {...base,message:v.message};
}
