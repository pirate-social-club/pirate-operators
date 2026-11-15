import assert from "node:assert/strict";
import {dirname} from "node:path";
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {hash,privateDirectory,syncDirectory,type OperationLease} from "./backend-state.ts";
/** Bind real owning read-only predicates and original request/resource/profile
 * before opening any restored actor namespace. No browser-supplied SQL. */
export async function writeColdPlan(input:{
 path:string;capturedRoots:string[];lease:OperationLease;generation:number;profileDigest:string;resourceId:string;
 communityId:string;origin:string;owningSourceSHA256:string;
 queries:Array<{id:string;sql:string;sha256:string;owningSourceSHA256:string}>;
}) {
 await input.lease.assertHeld();await privateDirectory(dirname(input.path));
 assert(input.capturedRoots.every(r=>input.path!==r && !input.path.startsWith(r+"/")),"cold_execution_plan_inside_restored_state");
 assert(["signed-intents","pending-nonces","uncertain-external-effects"].every(id=>input.queries.some(q=>q.id===id)),"complete_original_domain_predicates_required");
 for(const query of input.queries)assert(query.owningSourceSHA256===input.owningSourceSHA256 &&
  query.sha256===hash(query.sql) && /^SELECT\s/i.test(query.sql) && /\bFROM\b/i.test(query.sql) && !query.sql.includes(";"),"unadmitted_cold_domain_predicate");
 const value={installationId:input.lease.installationId,requestId:input.lease.operationId,generation:input.generation,
  profileDigest:input.profileDigest,resourceId:input.resourceId,communityId:input.communityId,origin:input.origin,
  owningSourceSHA256:input.owningSourceSHA256,queries:input.queries};
 const file=await open(input.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 await syncDirectory(dirname(input.path));return input.lease.record("exact-original-cold-domain-plan",{path:input.path,sha256:hash(JSON.stringify(value))});
}

