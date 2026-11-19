import type { SharedReservationPorts } from "./shared-recognition-reservations.ts";
import { sha256 } from "viem";
import { ownerAuthorizationRecord } from "../packages/community/owner-authorization-typed-data.ts";
import type { PrivateKeyAccount } from "viem/accounts";
import { bytes32, canonical, hashJson, insist } from "../packages/community/common.ts";
import { readMp3Probe, readMp3FrameWindow } from "../packages/moderation/mp3-windows.ts";
import type { AcrCredentials } from "../packages/moderation/acrcloud.ts";
import type { ProviderTransport } from "../packages/moderation/provider-http.ts";
import { acrCatalog } from "../packages/recognition/catalog-provider.ts";
import { catalogVerification, verificationFromReceipt } from "../packages/recognition/verification.ts";
import { originalIdentification } from "../packages/recognition/original-identification.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import { recognitionEffectBudget } from "../packages/recognition/effect-budget.ts";
import { recognitionProfile, type AcceptedIntent, type RecognitionProfile } from "../packages/recognition/intent.ts";
import type { CanonicalIntentPorts } from "../packages/recognition/canonical-intent.ts";
import { canonicalCommunity, type CanonicalCommunity } from "../packages/recognition/canonical-community.ts";
import { validateProviderBinding, type ManagedCatalogBinding } from "../packages/recognition/provider-binding.ts";
import type { Recording, VerifiedPublication } from "../packages/recognition/model.ts";
import { sharedRecognitionService } from "./shared-recognition.ts";

export type RecognitionWake={kind:'reservation';reservationId:string}|{kind:'recording';recordingId:string};
/** Managed composition. A private canonical registry and credentials are required;
 * a community receives only RecognitionProfile and its own publisher identity. */
export interface SharedRecognitionRuntimeInputs {
  db:D1Database; profile:RecognitionProfile; signer:PrivateKeyAccount;
  binding:ManagedCatalogBinding; credentials:AcrCredentials; catalogToken:string;
  communities:ReadonlyMap<string,CanonicalIntentPorts | CanonicalCommunity>;
  quotas:{service:number;community:number};
  queue:{send(message:RecognitionWake):Promise<unknown>};
  cancellation(ports:CanonicalIntentPorts,intent:AcceptedIntent):Promise<string>;
  withdrawal(ports:CanonicalIntentPorts,publication:VerifiedPublication):Promise<string>;
  providerTransport?:ProviderTransport;
  protectedCatalog?: SharedReservationPorts["protectedCatalog"];
  journal:{epoch:string;restoreAnchorSha256:string};
  now?:()=>number;
}
export function sharedRecognitionRuntime(inputs:SharedRecognitionRuntimeInputs) {
  const credentials=Object.freeze({...inputs.credentials});
  const journal=Object.freeze({epoch:bytes32(inputs.journal.epoch),restoreAnchorSha256:bytes32(inputs.journal.restoreAnchorSha256)});
  const profile=recognitionProfile(inputs.profile),binding=validateProviderBinding(inputs.binding,profile,credentials),
    now=inputs.now??Date.now,store=()=>new RecognitionStore(inputs.db,profile.namespace,now),
    community=(id:string)=>{const ports=inputs.communities.get(id);insist(ports,'recognition_community_unconfigured',503);return canonicalCommunity(ports);};
  const localCommunity=(id:string)=>{const ports=inputs.communities.get(id);
    insist(ports && "db" in ports,'recognition_remote_withdrawal_or_cancellation_unconfigured',503);return ports;};
  const installation=async()=>{
    const row=await inputs.db.withSession('first-primary').prepare('SELECT * FROM shared_recognition_installation WHERE namespace=?').bind(profile.namespace)
      .first<{profile_sha256:string;journal_epoch:string;restore_anchor_sha256:string}>();
    insist(row?.profile_sha256===profile.sha256&&row.journal_epoch===journal.epoch&&row.restore_anchor_sha256===journal.restoreAnchorSha256,
      'recognition_restore_or_installation_unqualified',503);
  };
  const source=(p:AcceptedIntent|VerifiedPublication)=>community(p.communityId).source(p);
  const readAudio=(p:AcceptedIntent|VerifiedPublication,signal:AbortSignal)=>community(p.communityId).audio(p,signal);
  const sample=async(p:AcceptedIntent|VerifiedPublication,signal=new AbortController().signal)=>{
    const bytes=await readAudio(p,signal),probe=await readMp3Probe(new Blob([bytes]).stream(),3600000,signal),
      window=await readMp3FrameWindow(new Blob([bytes]).stream(),probe.durationMs,'primary',4000000,signal);
    return {bytes:window.bytes,sampleSha256:sha256(window.bytes),audioSha256:p.audioSha256,canonicalAudioSha256:p.audioSha256};
  };
  const quota=recognitionEffectBudget(inputs.db,profile.namespace,inputs.quotas,async(r:Recording)=>{
    const row=await inputs.db.withSession('first-primary').prepare(`SELECT community_id FROM shared_recognition_reservations WHERE recording_id=?
      UNION ALL SELECT community_id FROM shared_recognition_publications WHERE recording_id=? LIMIT 1`)
      .bind(r.recording_id,r.recording_id).first<{community_id:string}>();
    insist(row,'recognition_quota_owner_missing',503);return row.community_id;
  });
  const loadAuthority=async(id:string)=>{
    await installation();
    if(!inputs.communities.has(id))return null;
    const config=await community(id).currentConfiguration();
    insist(config.communityId===id&&canonical(config.policies.recognition)===canonical(profile),'recognition_profile_changed',403);
    return {namespace:profile.namespace,profileSha256:profile.sha256,communityId:id,communityOrigin:config.app.origin,
      publisher:config.publisher,configurationRevision:config.configurationRevision,enabled:true};
  };
  const catalog=acrCatalog({namespace:profile.namespace,origin:binding.catalogOrigin,bucketId:binding.bucketId,token:inputs.catalogToken,
    transport:inputs.providerTransport,received:(kind,r,receipt)=>store().receipt(r,kind,receipt)});
  const verify=catalogVerification({credentials,transport:inputs.providerTransport,
    sample,received:(r,receipt)=>store().receipt(r,'verify',receipt)});
  const wakeRecording=async(recordingId:string)=>{await inputs.queue.send({kind:'recording',recordingId});};
  const service=sharedRecognitionService({db:inputs.db,namespace:profile.namespace,profileSha256:profile.sha256,origin:profile.origin,
    statusSigner:inputs.signer,now,loadAuthority,
    async verifyPublication(a,postId,revision) {
      return community(a.communityId).findPublication(postId,revision);
    },
    verifyWithdrawal:(a,p)=>inputs.withdrawal(localCommunity(a.communityId),p),
    async resolveEnrollment(){throw new Error('recognition_reservation_required');},
    wake:wakeRecording,
    enrollment:{catalog,readAudio,verify,authorizeSource:async p=>{await source(p);},
      authorizeUpload:async p=>{
        const ports=community(p.communityId),accepted=await ports.source(p),snapshot=await ports.read(accepted.jobId);
        // The trusted canonical read verifies the current controller signature,
        // scope, account and original intent through the pinned local/HTTP reader.
        insist(canonical(snapshot.intent)===canonical(accepted),"recognition_source_changed",409);
        const {authorization}=ownerAuthorizationRecord(snapshot.ownerAuthorization);
        insist(hashJson(authorization)===accepted.ownerAuthorizationSha256,"recognition_owner_authority_changed",403);
        return ()=>{
          const at=Math.floor(now()/1000);
          insist(at>=authorization.validFrom&&at<authorization.expiresAt,"owner_authorization_outside_window",403);
        };
      },recoverVerification:async r=>{const receipt=await store().verificationReceipt(r);return receipt?verificationFromReceipt(r,receipt):null;},
      authorizeEffect:async(effect,r)=>{await installation();validateProviderBinding(binding,profile,credentials);await quota(effect,r);
        if(effect==='verify') {const p=await store().source(r.recording_id);insist(p,'recognition_source_changed',409);
          await community(p.communityId).authorize(p,hashJson({recordingId:r.recording_id,attempt:r.attempt,purpose:'verify'}));}
      }},
    reservations:{db:inputs.db,profile,signer:inputs.signer,now,loadAuthority,
      verifyIntent:async(a,jobId)=>(await community(a.communityId).read(jobId)).intent,
      protectedCatalog:inputs.protectedCatalog,
      verifyPosting:(a,p,posting)=>community(a.communityId).posting(p,posting),
      verifyPublication:(a,p,posting)=>community(a.communityId).publication(p,posting),
      verifyCancellation:(a,p)=>inputs.cancellation(localCommunity(a.communityId),p),
      original:originalIdentification({credentials,transport:inputs.providerTransport,sample,
        authorize:(p,id)=>community(p.communityId).authorize(p,id),
        // The receipt callback is the canonical journal. A missing retained response is unresolved.
        recover:async operationId=>{const row=await inputs.db.withSession("first-primary").prepare("SELECT receipt_json FROM shared_recognition_original_calls WHERE operation_id=? AND state='received'").bind(operationId).first<{receipt_json:string|null}>();return row?.receipt_json?JSON.parse(row.receipt_json):null;}}),quotas:inputs.quotas,
      wake:async reservationId=>{await inputs.queue.send({kind:'reservation',reservationId});},wakeRecording},
  });
  return {
    async fetch(request:Request) {await installation();return service.fetch(request);},
    async queue(batch:Pick<MessageBatch<RecognitionWake>,'messages'>) {
      for(const message of batch.messages)try {
        await installation();
        if(message.body.kind==='reservation')await service.runReservation(message.body.reservationId);
        else await service.run(message.body.recordingId);
        message.ack();
      } catch {message.retry({delaySeconds:60});}
    },
    async scheduled() {await installation();return service.recover();},
  };
}
