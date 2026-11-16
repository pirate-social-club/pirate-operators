// Actual owned Anvil/D1 and pinned public actions. Only the HTTP transport fault
// is controlled: it fails eth_call, while forwarding all other RPC unchanged.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData,
  hashTypedData, keccak256, recoverTypedDataAddress, serializeErc8010Signature,
  serializeErc6492Signature, type Address, type Hex,
} from "viem";
import { http } from "viem";
import { hostedFixture, lower } from "./hosted-community-enrollment.ts";
import { canonical, hashJson, publicId, token } from "../../packages/community/common.ts";
import { directoryInstanceId } from "../../packages/community/shared-identity.ts";
import { validateWeb2Profile, web2ProfileDocument } from "../../packages/community/web2-directory.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { provisionHostedInvite, loadEnrollment } from "../../packages/community/hosted-enrollment-store.ts";
import { enrollmentTypedData, verifyEnrollmentProof } from "../../packages/community/hosted-enrollment.ts";
import { createHostedEnrollmentService } from "../../services/hosted-community-enrollment.ts";
import { ownerAuthorizationTypedData } from "../../packages/community/owner-authorization-typed-data.ts";
import { verifyOwnerTypedAuthorization } from "../../packages/community/owner-authorization-verifier.ts";
import type { OwnerAuthorization } from "../../packages/community/owner-authorization.ts";

export type AuthorityState="plain"|"code-deny"|"code-revert"|"delegated-deny"|"delegated-revert"|"code-valid";
async function childIdentities() {
  const ids=(await readFile(`/proc/self/task/${process.pid}/children`,"utf8")).trim().split(/\s+/).filter(Boolean);
  const rows=[];
  for(const id of ids)try {
    const procStat=await readFile(`/proc/${id}/stat`,"utf8"),fields=procStat.slice(procStat.lastIndexOf(")")+2).trim().split(/\s+/);
    rows.push({pid:Number(id),birth:fields[19],procStat});
  } catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return rows;
}
export async function walletAuthorityFixture() {
  const packet=process.env.PIRATE_WALLET_AUTHORITY_EVIDENCE_DIRECTORY??".local/wallet-account-authority-evidence";
  await mkdir(packet,{recursive:true});
  const f=await hostedFixture(),children=await childIdentities();
  const chain=defineChain({id:6343,name:"Owned wallet authority fixture",nativeCurrency:{name:"Test Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[f.local.transport.url!]}}});
  const methods:string[]=[],blockedCalls:string[]=[];let failCall=false,serverClosed=false;
  const proxy=createServer(async(req,res)=>{
    try {
      const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));
      const body=Buffer.concat(parts),parsed=JSON.parse(body.toString()),calls=Array.isArray(parsed)?parsed:[parsed];
      for(const c of calls)methods.push(c.method);
      if(failCall&&calls.some(c=>c.method==="eth_call")){blockedCalls.push("eth_call");res.writeHead(503);res.end("owned selective eth_call outage");return;}
      const response=await fetch(f.local.transport.url!,{method:"POST",headers:{"content-type":"application/json"},body});
      res.writeHead(response.status,{"content-type":"application/json"});res.end(await response.text());
    } catch {res.writeHead(503);res.end("owned RPC forwarding unavailable");}
  });
  const close=async()=>{
    if(serverClosed)return;serverClosed=true;
    if(proxy.listening){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
    await f.close();
    await mkdir(packet+"/cleanup",{recursive:true});
    const after=await childIdentities();
    await writeFile(packet+`/cleanup/fixture-${process.pid}-${Date.now()}.json`,JSON.stringify({nodePid:process.pid,proxyClosed:!proxy.listening,underlyingOwnedAnvilAndD1Disposed:true,childrenBefore:children,childrenAfter:after,remainingSameIdentities:children.filter(before=>after.some(a=>a.pid===before.pid&&a.birth===before.birth)),atUtc:new Date().toISOString()},null,2));
  };
  try {
    await f.rpc("anvil_setChainId",[6343]);
    proxy.listen(0,"127.0.0.1");await once(proxy,"listening");
    const port=(proxy.address() as {port:number}).port;
    const client=createPublicClient({chain,transport:http(`http://127.0.0.1:${port}`,{retryCount:0}),cacheTime:0});
    const wallet=createWalletClient({chain,account:f.accounts.admin,transport:http(f.local.transport.url!,{retryCount:0})});
    const template=await f.invite(),policy={...f.policy,deployment:{...f.policy.deployment,chainId:6343 as const}};
    const profile=validateWeb2Profile({...policy.deployment,communityKey:template.profile.communityKey,communityId:directoryInstanceId(6343,template.profile.communityKey),installationId:template.profile.installationId});
    const config={...template.config,chainId:6343 as const,communityId:profile.communityId};
    const secret=token();await provisionHostedInvite(f.db,policy,{id:publicId(),token:secret,allowanceId:publicId(),expiresAt:f.runtime.now()+1800},f.runtime.now());
    const bytes=new TextEncoder().encode(canonical(config)),pin=await preparePin(bytes,"application/json");f.pins.set(pin.uri,bytes);
    const runtime={...f.runtime,client,policy},service=createHostedEnrollmentService(runtime);
    const prepared=await f.post("/prepare",{inviteToken:secret,profile:web2ProfileDocument(profile),config,uri:pin.uri,noticeSha256:policy.noticeSha256},service);
    assert.equal(prepared.status,200,JSON.stringify(prepared));
    const enrollment=await loadEnrollment(f.db,prepared.body.enrollmentId as Hex);
    const authorization:OwnerAuthorization={schema:"pirate.owner-publishing-authorization/2",communityId:config.communityId,ownerWallet:lower(f.accounts.stranger.address),policy:config.policies.admission,validFrom:f.runtime.now()-60,expiresAt:f.runtime.now()+1800};
    const ownerData=ownerAuthorizationTypedData(authorization,config),enrollmentData=enrollmentTypedData(enrollment);
    const proofs={owner:await f.accounts.controller.signTypedData(ownerData),enrollment:await f.accounts.controller.signTypedData(enrollmentData)};
    const artifact=(label:string,value:unknown)=>writeFile(packet+`/${label}-${process.pid}-${Date.now()}.json`,JSON.stringify(value,(_k,v)=>typeof v==="bigint"?String(v):v,2));
    const setState=async(state:AuthorityState)=>{
      failCall=false;await f.rpc("anvil_setCode",[f.accounts.controller.address,"0x"]);
      const implementation=state.endsWith("revert")?f.compiled.MockInitializer!:f.compiled.MockAccount!;
      let transaction:Hex|undefined;
      if(state.startsWith("code-"))await f.rpc("anvil_setCode",[f.accounts.controller.address,implementation.runtime]);
      if(state.startsWith("delegated-")) {
        const deployed=await f.local.waitForTransactionReceipt({hash:await wallet.deployContract({abi:implementation.abi,bytecode:implementation.bytecode})});assert(deployed.contractAddress);
        const authorization=await f.accounts.controller.signAuthorization({contractAddress:deployed.contractAddress,chainId:6343,nonce:await f.local.getTransactionCount({address:f.accounts.controller.address})});
        transaction=await wallet.sendTransaction({to:f.accounts.admin.address,authorizationList:[authorization]});
        assert.equal((await f.local.waitForTransactionReceipt({hash:transaction})).status,"success");
      }
      if(state==="code-valid")await f.local.waitForTransactionReceipt({hash:await wallet.writeContract({address:f.accounts.controller.address,abi:implementation.abi,functionName:"initialize",args:[f.accounts.controller.address]})});
      await f.mine();
      const safe=await client.getBlock({blockTag:"safe"}),code=await client.getCode({address:f.accounts.controller.address,blockNumber:safe.number!});
      if(state.startsWith("delegated-"))assert(code?.startsWith("0xef0100"));
      if(state.startsWith("code-"))assert(code&&code!=="0x");
      return {state,code:code??"0x",codeHash:code?keccak256(code):null,safeBlock:safe.number,safeHash:safe.hash,delegationTransaction:transaction};
    };
    return {client,config,policy,enrollment,authorization,ownerData,enrollmentData,proofs,methods,blockedCalls,setState,close,artifact,
      actor:lower(f.accounts.controller.address),failEthCall:(value:boolean)=>{failCall=value;},
      async rawMatches(kind:"owner"|"enrollment"){const recovered=kind==="owner"?await recoverTypedDataAddress({...ownerData,signature:proofs.owner}):await recoverTypedDataAddress({...enrollmentData,signature:proofs.enrollment});return lower(recovered)===lower(f.accounts.controller.address);},
      async verify(kind:"owner"|"enrollment",signature:Hex=proofs[kind]) {
        if(kind==="owner")return verifyOwnerTypedAuthorization({authorization,signature},config,{client,currentConfiguration:async()=>config,now:runtime.now,maxSafeBlockAgeSeconds:300n});
        return verifyEnrollmentProof(client,policy,enrollment,lower(f.accounts.controller.address),signature,runtime.now);
      },
      async status(signature:Hex=proofs.enrollment){return f.post("/status",{enrollmentId:enrollment.id,controllerSignature:signature},service);},
      async direct1271(kind:"owner"|"enrollment") {
        try {return {result:await client.readContract({address:f.accounts.controller.address,abi:f.compiled.MockAccount!.abi,functionName:"isValidSignature",args:[(kind==="owner"?hashTypedData(ownerData):hashTypedData(enrollmentData)),proofs[kind]],blockTag:"safe"})};}
        catch(error){return {reverted:true,errorName:(error as Error).name};}
      },
      async wrapped(kind:"owner"|"enrollment",format:"6492"|"8010") {
        if(format==="6492")return serializeErc6492Signature({address:f.directory,data:"0x",signature:proofs[kind]});
        const account=f.compiled.MockAccount!,init=f.compiled.MockInitializer!;
        const implementation=await f.local.waitForTransactionReceipt({hash:await wallet.deployContract({abi:account.abi,bytecode:account.bytecode})});
        const initializer=await f.local.waitForTransactionReceipt({hash:await wallet.deployContract({abi:init.abi,bytecode:init.bytecode})});assert(implementation.contractAddress&&initializer.contractAddress);
        await f.rpc("anvil_setCode",[f.accounts.controller.address,"0x"]);await f.mine();
        return serializeErc8010Signature({authorization:await f.accounts.controller.signAuthorization({contractAddress:implementation.contractAddress,chainId:0,nonce:await f.local.getTransactionCount({address:f.accounts.controller.address})}),address:initializer.contractAddress,data:encodeFunctionData({abi:init.abi,functionName:"activate",args:[f.accounts.controller.address,f.accounts.controller.address]}),signature:proofs[kind]});
      },
      digest:(value:unknown)=>hashJson(value),now:runtime.now,
    };
  } catch(error){await close();throw error;}
}
