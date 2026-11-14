import { bytes32, exact, hashJson, insist, object, text } from "../community/common.ts";
import { recognitionProfile, type RecognitionProfile } from "./intent.ts";
import type { AcrCredentials } from "../moderation/acrcloud.ts";
export interface ManagedCatalogBinding {
  schema:"pirate.managed-recognition-binding/1";
  namespace:string; catalogOrigin:string; bucketId:string; projectId:string;
  identifyHost:string; accessKeySha256:string; associationEvidenceSha256:string;
}
/** Managed secret selection is not a community request. The reviewed association
 * evidence must qualify that this bucket and identify project actually share an index. */
export function validateProviderBinding(input:unknown,publicPin:RecognitionProfile,credentials:AcrCredentials):ManagedCatalogBinding {
  const v=object(input);exact(v,["schema","namespace","catalogOrigin","bucketId","projectId","identifyHost","accessKeySha256","associationEvidenceSha256"]);
  const pin=recognitionProfile(publicPin);
  insist(v.schema==='pirate.managed-recognition-binding/1',"recognition_provider_binding_invalid",503);
  const binding:ManagedCatalogBinding={schema:v.schema,namespace:bytes32(v.namespace),catalogOrigin:text(v.catalogOrigin,256),
    bucketId:text(v.bucketId,64),projectId:text(v.projectId,128),identifyHost:text(v.identifyHost,256),
    accessKeySha256:bytes32(v.accessKeySha256),associationEvidenceSha256:bytes32(v.associationEvidenceSha256)};
  insist(binding.namespace===pin.namespace&&hashJson(binding)===pin.providerBindingSha256&&
    binding.identifyHost===credentials.host&&binding.accessKeySha256===hashJson({accessKey:credentials.accessKey})&&
    /^(https:\/\/)(us-)?api-v2\.acrcloud\.com$/.test(binding.catalogOrigin)&&/^[1-9][0-9]*$/.test(binding.bucketId),
    "recognition_provider_binding_changed",503);
  return Object.freeze(binding);
}
