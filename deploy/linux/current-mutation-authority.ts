import assert from "node:assert/strict";
import type {OperationLease} from "./backend-state.ts";
import type {createProfileAuthority,ProfileAdmission} from "./full-profile-authority.ts";
import type {NamespaceProof} from "../../apps/community-wizard/server/linux-contracts.ts";

/** The owning native pipeline and protocol regressions use THIS same guard.
 * Admission is the real producer's verified original plus ACTUAL revalidated
 * namespace, never a stored plan/proof expiry or a ready/capability boolean. */
export function createCurrentMutationAuthority(input:{
  plan:{expiresAt:number;profileDigest:string};signal:AbortSignal;own:OperationLease;requireLivePlan:boolean;
  profileFor:()=>Promise<{original:ProfileAdmission;namespace:NamespaceProof}>;
  authority:Pick<Awaited<ReturnType<typeof createProfileAuthority>>,"current">;
}):()=>Promise<void>{
  return async()=>{
    assert(!input.signal.aborted,"native_effect_cancelled");
    if(input.requireLivePlan)assert(input.plan.expiresAt>Date.now(),"original_plan_expired_before_effects");
    const requested={expiresAt:input.plan.expiresAt,profileDigest:input.plan.profileDigest};
    await input.own.assertHeld();
    const actual=await input.profileFor();
    const original=structuredClone(actual.original),namespace=structuredClone(actual.namespace);
    assert(original.profileDigest===input.plan.profileDigest,"original_mutation_profile_changed");
    assert(namespace.status==="verified" && Number.isSafeInteger(namespace.expiresAt),"fresh_namespace_admission_required");
    // Both awaits are production boundaries. A shorter actual namespace TTL
    // must survive NEITHER a delayed operation lease NOR a signed-current read.
    await input.own.assertHeld();
    const current=await input.authority.current(original);
    assert.deepEqual(actual.original,original,"original_mutation_admission_changed");
    assert.deepEqual(actual.namespace,namespace,"fresh_namespace_admission_changed");
    assert.deepEqual({expiresAt:input.plan.expiresAt,profileDigest:input.plan.profileDigest},requested,"original_mutation_plan_changed");
    const now=Date.now();
    assert(namespace.expiresAt>now,"namespace_expired_before_effects");
    assert(current.expiresAt>now,"profile_current_authority_expired");
    assert(!input.signal.aborted,"native_effect_cancelled");
    if(input.requireLivePlan)assert(input.plan.expiresAt>now,"original_plan_expired_before_effects");
  };
}
