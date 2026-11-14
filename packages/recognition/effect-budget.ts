import { hashJson, insist, integer } from "../community/common.ts";
import type { Recording } from "./model.ts";
import type { RecognitionEffect } from "./worker.ts";
/** Pin one finite allowance per namespace/community/effect. No rolling clock,
 * grant hash, restart counter or expiry can replace its original ceiling. */
export function recognitionEffectBudget(db:D1Database,namespace:string,limits:{service:number;community:number},
  community:(recording:Recording)=>Promise<string>) {
  integer(limits.service,1,1000000);integer(limits.community,1,1000000);
  return async(effect:RecognitionEffect,r:Recording)=>{
    insist(r.namespace===namespace,"recognition_namespace_mismatch",403);
    const id=await community(r),scopes=[`recognition:${namespace}:effects`,`recognition:${namespace}:${id}:effects`],
      operation=hashJson({purpose:"recognition-effect/1",recordingId:r.recording_id,effect,attempt:r.attempt});
    await db.batch([
      ...scopes.map((scope,i)=>db.prepare('INSERT INTO shared_recognition_quota_limits(scope,ceiling) VALUES(?,?) ON CONFLICT DO NOTHING').bind(scope,i===0?limits.service:limits.community)),
      ...scopes.map(scope=>db.prepare('INSERT INTO shared_recognition_quota_charges(operation_id,scope) VALUES(?,?) ON CONFLICT DO NOTHING').bind(operation,scope)),
    ]);
    const rows=await db.withSession('first-primary').prepare('SELECT scope,ceiling FROM shared_recognition_quota_limits WHERE scope IN (?,?)').bind(...scopes).all<{scope:string;ceiling:number}>();
    insist(scopes.every((s,i)=>rows.results.find(r=>r.scope===s)?.ceiling===(i===0?limits.service:limits.community)),"recognition_quota_changed",409);
  };
}
