import assert from "node:assert/strict";
import type {ProfileAdmission,CurrentAdmission} from "./full-profile-authority.ts";

/** The actual native factory and protocol cases share this connected pipeline.
 * Scope/profile/key preparation is never authority to issue an HTTP mutation.
 * The final callback is the real current/namespace/lease guard, not a ready flag.
 */
export function createApplicationReadbackAuthority(input:{
 captured:ProfileAdmission;capturedCurrent:CurrentAdmission;signal:AbortSignal;
 original:()=>Promise<ProfileAdmission>;current:(original:ProfileAdmission)=>Promise<CurrentAdmission>;
 assertCurrent:()=>Promise<void>;
}):()=>Promise<void>{
 const captured=structuredClone(input.captured),current=structuredClone(input.capturedCurrent);
 const signal=input.signal,original=input.original,readCurrent=input.current,assertCurrent=input.assertCurrent;
 return async()=>{
  assert(!signal.aborted,"native_readback_cancelled");
  const fresh=await original();
  assert.deepEqual(fresh,captured,"native_original_scope_changed");
  const actual=await readCurrent(fresh);
  assert.deepEqual(actual,current,"native_current_generation_changed");
  assert(!signal.aborted,"native_readback_cancelled");
  // No additional scope preparation await follows the real mutation guard.
  await assertCurrent();
  assert(!signal.aborted,"native_readback_cancelled");
 };
}
