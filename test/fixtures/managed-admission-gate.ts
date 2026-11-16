// Explicit local authority fixture, backed by actual D1. It does not issue a
// production grant or replace signature/current configuration verification.
import assert from "node:assert/strict";
import {canonical,hashJson,insist} from "../../packages/community/common.ts";
import type {OwnerBudgetGrant,OwnerBudgetAsset} from "../../packages/release/owner-grant.ts";
import type {ManagedAdmissionGate} from "../../packages/release/managed-admission-gate.ts";
export async function managedAdmissionFixture(db:D1Database,input:OwnerBudgetGrant) {
  const grant=structuredClone(input),digest=hashJson(grant),reference="local-admission-reference",selection=hashJson({grant:digest,reference}),revision=1;
  await db.prepare(`CREATE TABLE IF NOT EXISTS fixture_managed_admission(community TEXT PRIMARY KEY,grant_digest TEXT,selection TEXT,reference TEXT,revision INTEGER,active INTEGER,expires_at INTEGER)`).run();
  await db.prepare("INSERT INTO fixture_managed_admission VALUES(?,?,?,?,?,1,?)").bind(grant.communityId,digest,selection,reference,revision,grant.expiresAt).run();
  let armed:"reservation"|"dispatch"|null=null,asset:OwnerBudgetAsset|undefined,revoked=false,conditionCalls=0,dispatchCalls=0;
  const revoke=async()=>{await db.prepare("UPDATE fixture_managed_admission SET active=0,revision=revision+1 WHERE community=?").bind(grant.communityId).run();revoked=true;};
  async function validate(value:Readonly<OwnerBudgetGrant>) {
    insist(canonical(value)===canonical(grant),"fixture_gate_grant_changed",403);
    const row=await db.prepare("SELECT * FROM fixture_managed_admission WHERE community=?").bind(grant.communityId).first<Record<string,unknown>>();
    insist(row?.active===1&&row.revision===revision&&row.selection===selection&&row.reference===reference&&row.grant_digest===digest,"managed_admission_not_current",403);
  }
  const gate:ManagedAdmissionGate={
    async reservationCondition(value,original) {
      conditionCalls++;await validate(value);
      assert(original.operationId && original.requestHash && BigInt(original.requested)>0n);
      // Revoke after authenticated preparation, before the reservation's SQL.
      if(armed==="reservation"&&(!asset||original.asset===asset)){armed=null;await revoke();}
      return {clause:`EXISTS(SELECT 1 FROM fixture_managed_admission WHERE community=? AND grant_digest=? AND selection=? AND reference=? AND revision=? AND active=1 AND expires_at>unixepoch()) AND unixepoch()>=? AND unixepoch()<?`,
        binds:[grant.communityId,digest,selection,reference,revision,grant.validFrom,grant.expiresAt],code:"managed_admission_not_current"};
    },
    async beforeDispatch(value,original) {
      dispatchCalls++;assert(original.operationId && original.requestHash);
      if(armed==="dispatch"){armed=null;await revoke();}
      await validate(value);
      insist(Math.floor(Date.now()/1000)>=grant.validFrom&&Math.floor(Date.now()/1000)<grant.expiresAt,"owner_grant_outside_window",403);
    },
  };
  return {gate,revoke,arm:(boundary:"reservation"|"dispatch",selectedAsset?:OwnerBudgetAsset)=>{armed=boundary;asset=selectedAsset;},
    get revoked(){return revoked;},get calls(){return {condition:conditionCalls,dispatch:dispatchCalls};}};
}
