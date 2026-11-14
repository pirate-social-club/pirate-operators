import { sha256 } from "viem";
import { hashJson, insist, object } from "../community/common.ts";
import { identifyMp3, type AcrCredentials } from "../moderation/acrcloud.ts";
import { providerFetch, providerJson, type ProviderResponse, type ProviderTransport } from "../moderation/provider-http.ts";
import type { AcceptedIntent } from "./intent.ts";
import type { RecognitionStore } from "./store.ts";
/** Raw receipt is durably retained by identifyMp3's receipt callback before interpretation. */
export interface OriginalIdentification {
  identify(intent:AcceptedIntent,operationId:string,received:(receipt:ProviderResponse)=>Promise<void>,beforeSend:()=>Promise<void>):Promise<void>;
  recover(operationId:string):Promise<ProviderResponse|null>;
}
export function originalIdentification(options:{credentials:AcrCredentials;transport?:ProviderTransport;
  sample(intent:AcceptedIntent):Promise<{bytes:Uint8Array;sampleSha256:string;audioSha256:string}>;
  authorize(intent:AcceptedIntent,operationId:string):Promise<void>;
  recover(operationId:string):Promise<ProviderResponse|null>}):OriginalIdentification {
  return {recover:options.recover, async identify(p,id,received,beforeSend) {
    const sample=await options.sample(p);
    insist(sample.audioSha256===p.audioSha256 && sha256(sample.bytes)===sample.sampleSha256,"recognition_sample_changed",409);
    await identifyMp3(sample.bytes,options.credentials,received,{async request(request) {
      await beforeSend();await options.authorize(p,id);await beforeSend();
      return (options.transport??providerFetch).request(request);
    }});
  }};
}
/** No-match is acceptable only under the namespace gate and complete catalog.
 * Same-creator reuse never grants permission to another creator, even with permissive terms. */
export async function originalDisposition(store:RecognitionStore,intent:AcceptedIntent,receipt:ProviderResponse) {
  const body=providerJson(receipt), code=object(body.status).code;
  if(code===1001) return null;
  insist(code===0,"recognition_original_inconclusive",409);
  const metadata=object(body.metadata), candidates:{kind:string;id:string}[]=[];
  for(const kind of ["music","custom_files"]) {
    const rows=metadata[kind]??[];
    insist(Array.isArray(rows)&&rows.length<=64,"recognition_candidates_invalid",503);
    for(const item of rows) {
      const row=object(item), meta=row.user_defined==null?{}:object(row.user_defined);
      if(meta.content_type==='video_audio') continue;
      insist(typeof row.acrid==='string'&&row.acrid.length>0,"recognition_candidates_invalid",503);
      candidates.push({kind,id:row.acrid});
    }
  }
  insist(candidates.length===1&&candidates[0]!.kind==='custom_files',"recognition_original_ambiguous",409);
  const r=await store.matched(candidates[0]!.id);
  insist(r&&r.creator_key===intent.creatorKey,"recognition_original_creator_conflict",409);
  return {id:r.recording_id,evidence:hashJson(receipt)};
}
