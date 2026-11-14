// Exact Naming v3 join only. No authority verifier, registry SDK or member issuer.
import type {Hex} from "viem";
import {bindingKey, namespaceBinding, type NamespaceBindingPort, type NamespaceAuthorityPortV3} from "../../../packages/community-names/namespace-import.ts";
import {sharedNamespaceProofFrom, sameNamespaceAuthority} from "../../../packages/community-setup/shared-namespace-proof.ts";
import {fields,requireLinux,reference,text} from "../../../packages/community-setup/shared-linux-profile.ts";
import {mappingFrom} from "../../../packages/community-setup/shared-linux-infrastructure.ts";
import {canonical} from "./linux-journal.ts";
import type {NamespaceProof,NamespaceAuthorityResult,NamespaceAuthorityPort,NamespaceRequestRecoveryPort,OriginalInstallationPort} from "./linux-contracts.ts";
export function exactNamespaceProof(value:NamespaceProof) {
  const {status,tld,correction,...proof}=value;
  return sharedNamespaceProofFrom(proof);
}
export function namespaceResultFrom(value:unknown,tld:string):NamespaceAuthorityResult {
  const v = value as {status?:unknown};
  if(v?.status==="pending"||v?.status==="unavailable") {
    const p=fields(value,["status","tld","correction"]);
    requireLinux(p.tld===tld,"namespace_changed","Use the selected issuance namespace.");
    return {status:v.status,tld,correction:text(p.correction,240)};
  }
  const p=fields(value,["status","tld","correction","id","binding","authorityKind","externalAuthorityId","evidenceDigest","onChainAuthorityRevision","onChainPolicyRevision","onChainScopeRevision","expiresAt","purpose","memberIssuance"]);
  requireLinux(p.status==="verified" && p.tld===tld,"namespace_changed","Verify current external namespace control.");
  const {status,tld:ignored,correction,...body}=p;
  const proof=sharedNamespaceProofFrom(body);
  requireLinux(proof.binding.issuanceTld===tld,"namespace_changed","Proof is for another namespace.");
  return {...proof,status:"verified",tld,correction:typeof correction==="string"?correction.slice(0,240):""};
}
export function createSharedWizardNamespacePort(input:{
  authority:NamespaceAuthorityPortV3|undefined;bindings:NamespaceBindingPort|undefined;
  requests:NamespaceRequestRecoveryPort|undefined;originals:OriginalInstallationPort|undefined;
}):NamespaceAuthorityPort {
  const available=()=>requireLinux(input.authority?.version===3 && input.bindings && input.originals,"namespace_unavailable","Connect the actual shared namespace control and original installation services.");
  const current=async()=>{available();return namespaceBinding(await input.bindings!.currentBinding());};
  const original=async(identity:Parameters<OriginalInstallationPort["requireOriginal"]>[0]["identity"],b:ReturnType<typeof namespaceBinding>)=>{
    available();
    const m=mappingFrom(await input.originals!.requireOriginal({identity,binding:b}));
    requireLinux(m.communityId===identity.communityId && m.communityId===b.communityId &&
      m.directoryInstallationId===b.installationId && m.deploymentIdentityDigest===b.deploymentIdentityDigest &&
      bindingKey(await current())===bindingKey(b),"namespace_mapping_changed","Use the authenticated original installation mapping and exact resource binding.");
    return m;
  };
  const project=(proof:unknown):NamespaceProof=>{
    const p=sharedNamespaceProofFrom(proof);
    return {...p,status:"verified",tld:p.binding.issuanceTld,correction:"External namespace binding verified. Member claims require separate authorization."};
  };
  return {
    version:3,
    assertWritable(){available();requireLinux(input.requests,"namespace_recovery_unavailable","Connect the real durable namespace caller journal before any proof attempt.");},
    async begin(id){available();requireLinux(input.requests,"namespace_recovery_unavailable","Connect the actual durable namespace caller journal.");return input.requests.begin(id,()=>input.authority!.begin());},
    async complete(value){available();requireLinux(input.requests,"namespace_recovery_unavailable","Connect the actual durable namespace caller journal.");return input.requests.complete(value.requestId,async()=>project(await input.authority!.complete({challengeId:value.challengeId as Hex,proof:value.proof})));},
    async recover(id){reference(id);requireLinux(input.requests,"namespace_recovery_unavailable","The original proof request remains pending until its real caller journal is reconciled.");return input.requests.recover(id);},
    async inspect(value){
      if(!input.authority || !input.bindings || !input.originals)return {status:"unavailable",tld:value.tld,correction:"Actual namespace authority and original installation mapping are unavailable."};
      const b=await current();
      requireLinux(value.identity && value.identity.communityId===b.communityId && value.tld===b.issuanceTld && value.hostingOrigin===b.hostingOrigin,"namespace_binding_required","Prepare the original shared installation identity before namespace proof.");
      await original(value.identity,b);
      const proof=project(await input.authority.inspect({binding:b}));
      requireLinux(bindingKey(await current())===bindingKey(b) && bindingKey(proof.binding)===bindingKey(b),"namespace_changed","Shared binding changed while observing authority.");
      return proof;
    },
    async revalidate(value){
      const b=await current(), p=value.profile.infrastructure;
      requireLinux(bindingKey(b)===bindingKey(p.binding),"namespace_changed","Use the original profile/source and mapping.");
      const mapping=await original(value.profile.identity,b);
      requireLinux(canonical(mapping)===canonical(p.mapping),"namespace_mapping_changed","Keep the authenticated original mapping receipt.");
      const proof=project(await input.authority!.revalidate({proof:exactNamespaceProof(value.proof),binding:b}));
      requireLinux(bindingKey(await current())===bindingKey(b) && sameNamespaceAuthority(proof,value.proof),"namespace_changed","Authority, permission role, source or revision changed.");
      return proof;
    }
  };
}
