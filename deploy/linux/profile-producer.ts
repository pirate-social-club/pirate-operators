import assert from "node:assert/strict";
import {infrastructureFrom} from "../../packages/community-setup/shared-linux-infrastructure.ts";
import {linuxDraftFrom,identityFrom} from "../../packages/community-setup/shared-linux-profile.ts";
import {exactNamespaceProof} from "../../apps/community-wizard/server/shared-namespace-port.ts";
import {join} from "node:path";
import {linuxProfileFrom,type LinuxDraftV2,type LinuxCommunityProfileV2} from "../../packages/community-setup/shared-linux-profile.ts";
import type {NamespaceProof} from "../../apps/community-wizard/server/linux-contracts.ts";
import {canonicalDigest,readPrivateJSON,immutableRecord,verifyRecord,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import type {createManagedKeyClient} from "./managed-key-channel.ts";
import type {createProfileAuthority,ProfileAdmission} from "./full-profile-authority.ts";
import type {OperationLease} from "./backend-state.ts";
export interface ProfileTemplate {
  installationId:string;generation:number;issuedAt:number;expiresAt:number;settings:LinuxDraftV2;
  infrastructure:LinuxCommunityProfileV2["infrastructure"];
  identity:LinuxCommunityProfileV2["identity"];runtime:LinuxCommunityProfileV2["runtime"];learning:LinuxCommunityProfileV2["learning"];
}
export async function produceOriginalProfile(input:{
  templateFile:string;trust:TrustAnchor;requestId:string;draft:LinuxDraftV2;proof:NamespaceProof;
  retainedIdentity:LinuxCommunityProfileV2["identity"]|null;outputDirectory:string;lease:OperationLease;
  channel:Awaited<ReturnType<typeof createManagedKeyClient>>;authority:Awaited<ReturnType<typeof createProfileAuthority>>;
}) {
  const template=await readProfileTemplate(input.templateFile,input.trust,input.lease.installationId);
  assert.deepEqual(input.draft,template.settings,"selected_signed_settings_changed");
  if(input.retainedIdentity)assert.deepEqual(input.retainedIdentity,template.identity,"original_resource_identity_required");
  const ns=input.proof;
  const profile=linuxProfileFrom({schema:"pirate.community-linux-profile/2",settings:input.draft,identity:template.identity,
    runtime:template.runtime,learning:input.draft.features.learning?template.learning:null,
    infrastructure:template.infrastructure,namespace:exactNamespaceProof(input.proof)});
  const body:ProfileAdmission={installationId:template.installationId,generation:template.generation,issuedAt:template.issuedAt,
    expiresAt:template.expiresAt,requestId:input.requestId,recordId:"profile-"+canonicalDigest({request:input.requestId,profile}),
    profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile"};
  const signed=await input.channel.signProfile(body,template.generation) as SignedRecord<ProfileAdmission>;
  // The actual managed signing agent returns a signature, never authority by
  // itself. Match the ENTIRE intended body, then check original/current owners.
  assert.deepEqual(verifyRecord(signed,input.trust),body,"profile_signer_replaced_original_body");
  assert(template.expiresAt>Date.now(),"profile_template_expired_during_signing");
  await input.authority.admit(signed,input.proof);
  await immutableRecord(input.outputDirectory,body.recordId,signed,input.lease);
  return signed;
}



/** Genuine signed server preparation before namespace proof. It establishes the
 * selected public settings/identity/mapping, never namespace authorization. */
export async function readProfileTemplate(path:string,trust:TrustAnchor,installationId:string){
 const t=verifyRecord(await readPrivateJSON<SignedRecord<ProfileTemplate>>(path),trust);
 assert(t.installationId===installationId && t.issuedAt<=Date.now() && t.expiresAt>Date.now() &&
  Number.isSafeInteger(t.generation) && t.generation>0,"signed_shared_template_invalid");
 assert.deepEqual(linuxDraftFrom(t.settings),t.settings);
 assert.deepEqual(identityFrom(t.identity),t.identity);
 assert.deepEqual(infrastructureFrom(t.infrastructure,t.identity,t.settings),t.infrastructure);
 assert(t.infrastructure.mapping.linuxInstallationId===installationId,"original_mapping_required");
 return t;
}
