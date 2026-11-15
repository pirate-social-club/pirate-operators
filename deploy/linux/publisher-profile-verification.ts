import assert from "node:assert/strict";
import {privateKeyToAccount} from "viem/accounts";
import {verifyRecord,readPrivateJSON,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import type {createManagedKeyClient} from "./managed-key-channel.ts";
/** Current publisher authority is separate from HNS/registry issuance. The
 * Directory owner supplies its actual current-read evidence; a local key
 * match alone cannot establish this admission or full application readiness. */
export async function configuredPublisherVerified(input:{
 profileId:string;installationId:string;admissionFile:string;trust:TrustAnchor;
 channel:Awaited<ReturnType<typeof createManagedKeyClient>>;
}) {
 const actual=verifyRecord(await readPrivateJSON<SignedRecord<{
  installationId:string;expiresAt:number;publisherProfiles?:Array<{profileId:string;keyRef:string;generation:number;
  address:string;authorityEvidenceSha256:string;expiresAt:number;forbiddenGlobalAuthorityAddresses:string[]}>;
 }>>(input.admissionFile),input.trust);
 assert(actual.installationId===input.installationId && actual.expiresAt>Date.now());
 const binding=actual.publisherProfiles?.find(x=>x.profileId===input.profileId);if(!binding)return false;
 assert(binding.expiresAt>Date.now() && binding.expiresAt<=Date.now()+60000 &&
  /^[a-f0-9]{64}$/.test(binding.authorityEvidenceSha256),"actual_current_publisher_authority_read_required");
 return input.channel.withKey(binding.keyRef,binding.generation,async key=>{
  const account=privateKeyToAccount(("0x"+Buffer.from(key).toString("hex")) as `0x${string}`);
  assert(account.address.toLowerCase()===binding.address.toLowerCase() &&
   !binding.forbiddenGlobalAuthorityAddresses.some(x=>x.toLowerCase()===account.address.toLowerCase()),"community_publisher_must_not_be_global_contract_administrator");
  return true;
 });
}

