// Failures written BEFORE production changes: a raw-key signature must not
// override code-bearing/delegated ERC1271 denial/revert, and selective eth_call
// failure must remain unavailable. Real library, HTTP RPC and EVM only.
import test from "node:test";
import assert from "node:assert/strict";
import { walletAuthorityFixture, type AuthorityState } from "./fixtures/wallet-account-authority.ts";
import { CommunityError } from "../packages/community/common.ts";

for(const kind of ["owner","enrollment"] as const) {
  for(const state of ["code-deny","code-revert","delegated-deny","delegated-revert"] as const) test(`${kind}: ${state} cannot downgrade to a valid raw account key`,{timeout:60000},async(t)=>{
    const f=await walletAuthorityFixture();t.after(f.close);
    const account=await f.setState(state);assert.equal(await f.rawMatches(kind),true);
    const direct=await f.direct1271(kind);assert.notEqual(direct.result,"0x1626ba7e");
    const start=f.methods.length;
    let accepted=false,error:unknown;try {await f.verify(kind);accepted=true;}catch(e){error=e;}
    await f.artifact(`${kind}-${state}`,{account,direct,rawKeyMatches:true,accepted,error:error instanceof Error?{name:error.name,message:error.message}:null,verificationMethods:f.methods.slice(start),signatureDigest:f.digest(f.proofs[kind])});
    assert.equal(f.methods.slice(start).some(m=>m.startsWith("eth_send")),false);
    assert.equal(accepted,false,"contract authority denial/revert must not fall back to raw ECDSA");
  });
  for(const state of ["plain","code-deny"] as const) test(`${kind}: selective eth_call failure for ${state} stays unavailable`,{timeout:60000},async(t)=>{
    const f=await walletAuthorityFixture();t.after(f.close);
    const account=await f.setState(state);assert.equal(await f.rawMatches(kind),true);
    f.failEthCall(true);assert.equal(await f.client.getChainId(),6343);assert((await f.client.getBlock({blockTag:"safe"})).hash);
    let accepted=false,error:unknown;try {await f.verify(kind);accepted=true;}catch(e){error=e;}
    const status=kind==="enrollment"?await f.status():null;
    await f.artifact(`${kind}-${state}-rpc`,{account,accepted,blockedCalls:f.blockedCalls,error:error instanceof Error?{name:error.name,status:error instanceof CommunityError?error.status:null}:null,status});
    assert(f.blockedCalls.length>0,"the actual eth_call transport fault was reached");
    assert.equal(accepted,false,"an RPC failure must not become raw-key acceptance");
    if(kind==="owner")assert(error instanceof CommunityError&&error.status===503);
    else {assert.equal(status!.status,503);assert.equal(status!.body.error,"enrollment_authentication_unavailable");}
  });
  for(const state of ["plain","code-valid"] as AuthorityState[]) test(`${kind}: actual ${state} authority remains valid`,{timeout:60000},async(t)=>{
    const f=await walletAuthorityFixture();t.after(f.close);await f.setState(state);await f.verify(kind);
  });
  for(const format of ["6492","8010"] as const)test(`${kind}: real ERC${format} execution remains read-only`,{timeout:60000},async(t)=>{
    const f=await walletAuthorityFixture();t.after(f.close);
    await f.setState(format==="6492"?"code-valid":"plain");
    const proof=await f.wrapped(kind,format),before=await f.client.getTransactionCount({address:f.actor});
    const methods=f.methods.length;await f.verify(kind,proof);
    if(format==="8010")assert.equal(await f.client.getCode({address:f.actor}),undefined);
    assert.equal(await f.client.getTransactionCount({address:f.actor}),before);
    assert.equal(f.methods.slice(methods).some(m=>m.startsWith("eth_send")),false);
  });
}
