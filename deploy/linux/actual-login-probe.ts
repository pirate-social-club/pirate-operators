import assert from "node:assert/strict";
import {timingSafeEqual} from "node:crypto";
import {privateKeyToAccount} from "viem/accounts";
import {createSiweMessage,parseSiweMessage} from "viem/siwe";
import type {SiweChallenge,SignInChallenge} from "../../packages/community/accounts.ts";
import {readSignInMessageV4} from "../../packages/protocol/learning-results-v4.ts";
import {actualHTTPS} from "./actual-service-readback.ts";
export interface LoginScope {
 origin:string;communityId:string;chainId:6343|31337;contract:string;publicationPolicy:string;
}
export type AcceptedLoginChallenge=Readonly<SiweChallenge|SignInChallenge>;
// Exact ordinary statement from the frozen accounts.ts:170-181 producer.
// Its ordinary login chain is6343, including a withdrawn local-V4 fallback.
const ORDINARY_STATEMENT="Sign in to this community. This does not join, create a creator wallet or authorize spending.";
export function validateLoginChallenge(value:unknown,address:string,scope:LoginScope):AcceptedLoginChallenge {
 assert(value!==null && typeof value==="object" && !Array.isArray(value),"actual_login_challenge_shape");
 const v=value as Record<string,unknown>,v4=v.kind==="sign-in-v4";
 assert.deepEqual(Object.keys(v).sort(),v4?["id","kind","message"]:["id","message"],"actual_login_challenge_shape");
 assert(typeof v.id==="string" && /^[a-f0-9]{64}$/.test(v.id) && typeof v.message==="string" && v.message.length<=8192,"actual_login_challenge_shape");
 const origin=new URL(scope.origin);assert(origin.protocol==="https:" && origin.origin===scope.origin && [6343,31337].includes(scope.chainId));
 const siwe=parseSiweMessage(v.message),now=Date.now(),issued=siwe.issuedAt?.getTime();
 assert(siwe.address && siwe.address.toLowerCase()===address.toLowerCase() && siwe.uri===scope.origin &&
  siwe.domain===origin.host && siwe.version==="1" && issued!==undefined && Number.isSafeInteger(issued) &&
  issued<=now+1000 && now-issued<=120000 && typeof siwe.nonce==="string" &&
  /^[a-f0-9]{64}$/.test(siwe.nonce) && !/^0+$/.test(siwe.nonce),"actual_login_scope_or_time_changed");
 if(v4){
  const actual=readSignInMessageV4(v.message);assert(actual);
  assert(actual.context.origin===scope.origin && actual.context.communityId===scope.communityId &&
   actual.context.chainId===scope.chainId && actual.context.contract.toLowerCase()===scope.contract.toLowerCase() &&
   actual.context.publicationPolicy===scope.publicationPolicy,"actual_sign_in_grant_scope_changed");
  return Object.freeze({id:v.id,kind:"sign-in-v4",message:v.message});
 }
 // The producer intentionally omits kind. Never infer V4 permission from the
 // configured Learning profile, an ordinary session or a withdrawal fallback.
 assert(siwe.chainId===6343 && !siwe.resources?.length && siwe.expirationTime &&
  siwe.expirationTime.getTime()===issued+300000 && siwe.expirationTime.getTime()>now &&
  siwe.expirationTime.getTime()<=now+300000,"unexpected_login_authorization");
 const canonical=createSiweMessage({address:siwe.address,chainId:6343,domain:origin.host,uri:scope.origin,version:"1",
  nonce:siwe.nonce,issuedAt:siwe.issuedAt,expirationTime:siwe.expirationTime,statement:ORDINARY_STATEMENT});
 assert(canonical===v.message && !readSignInMessageV4(v.message),"unexpected_login_authorization");
 return Object.freeze({id:v.id,message:v.message});
}
/** Pin the original request, signer and scope across all transport/signing
 * awaits. Protocol tests can exercise this real guard without a fake HTTP app. */
export function captureLoginBinding(input:{key:Uint8Array;scope:LoginScope;signal:AbortSignal}){
 assert(input.key.length===32 && [6343,31337].includes(input.scope.chainId));
 const scope=Object.freeze({...input.scope}),signal=input.signal,key=Buffer.from(input.key);
 let disposed=false,account:ReturnType<typeof privateKeyToAccount>;
 try{account=privateKeyToAccount(("0x"+key.toString("hex")) as `0x${string}`);}catch(error){key.fill(0);throw error;}
 function assertCurrent(){
  assert(!disposed && !signal.aborted && input.signal===signal,"actual_login_binding_withdrawn");
  assert.deepEqual(input.scope,scope,"actual_login_binding_changed");
  assert(input.key.length===key.length && timingSafeEqual(input.key,key),"actual_login_signer_changed");
 }
 return {
  scope,address:account.address,signal,assertCurrent,
  async sign(value:unknown){
   assertCurrent();const proof=validateLoginChallenge(value,account.address,scope);assertCurrent();
   const signature=await account.signMessage({message:proof.message});
   assertCurrent();
   // Fresh parsing/time checks and exact original bytes before verification:
   // a deferred mutation cannot exchange the challenge or promote plain toV4.
   assert.deepEqual(validateLoginChallenge(value,account.address,scope),proof,"actual_login_challenge_changed");
   validateLoginChallenge(proof,account.address,scope);return {proof,signature};
  },
  dispose(){disposed=true;key.fill(0);}
 };
}
/** Real challenge/signature/verify using the actual account handler. Login
 * never relays a publication authorization, posts content or sponsors gas. */
export async function actualLogin(input:{key:Uint8Array;scope:LoginScope;signal:AbortSignal;authorize:()=>Promise<void>}) {
 const authorize=input.authorize;assert.equal(typeof authorize,"function","actual_current_login_authority_required");
 const binding=captureLoginBinding(input),headers={"Content-Type":"application/json",Origin:binding.scope.origin};
 try{
  binding.assertCurrent();const requestBody=Buffer.from(JSON.stringify({address:binding.address}));
  let challenge:Awaited<ReturnType<typeof actualHTTPS>>;
  try{
   await authorize();binding.assertCurrent();
   challenge=await actualHTTPS({url:binding.scope.origin+"/api/auth/challenge",method:"POST",
   body:requestBody,headers,seconds:15,signal:binding.signal});}finally{requestBody.fill(0);}
  let value:AcceptedLoginChallenge;
  try{binding.assertCurrent();assert(challenge.status===200);
   value=validateLoginChallenge(JSON.parse(challenge.bytes.toString("utf8")),binding.address,binding.scope);}
  finally{challenge.bytes.fill(0);}
  const {proof,signature}=await binding.sign(value);binding.assertCurrent();
  const verifyBody=Buffer.from(JSON.stringify({id:proof.id,signature}));
  let response:Awaited<ReturnType<typeof actualHTTPS>>;
  try{
   // Challenge transport and cryptographic signing are preparation, not a
   // cached authorization to create an account/session. Revalidate LAST.
   await authorize();binding.assertCurrent();
   validateLoginChallenge(proof,binding.address,binding.scope);
   response=await actualHTTPS({url:binding.scope.origin+"/api/auth/verify",method:"POST",
   body:verifyBody,headers,seconds:15,signal:binding.signal});}finally{verifyBody.fill(0);}
  try{
   await authorize();binding.assertCurrent();validateLoginChallenge(proof,binding.address,binding.scope);
   assert(response.status===200 && JSON.parse(response.bytes.toString("utf8")).authenticated===true);
   const cookie=response.setCookie?.find(x=>x.startsWith("__Host-community_session="));
   assert(cookie && /;\s*Secure/i.test(cookie) && /;\s*HttpOnly/i.test(cookie) && /;\s*SameSite=/i.test(cookie),"actual_host_bound_cookie_required");
   return {cookie:cookie.split(";")[0]!,wallet:binding.address,challengeId:proof.id};
  }finally{response.bytes.fill(0);}
 }finally{binding.dispose();}
}
