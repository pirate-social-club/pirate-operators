// Source-only proposed acceptance fixture. UNRUN. Actual handlers/D1/R2/crypto;
// only ACRCloud, IPFS and public-chain transports are explicit simulations.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { communityId, address } from "../packages/community/manifest-core.ts";
import { catalogCommunityFixture } from "./fixtures/recognition-community.ts";
import { sharedRecognitionRuntime, type RecognitionWake } from "../services/shared-recognition-runtime.ts";
import { communityFetch, communityQueue, communityScheduled, type CommunityDependencies, type CommunityEnv } from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import type { CanonicalIntentPorts } from "../packages/recognition/canonical-intent.ts";
import type { RecognitionProfile } from "../packages/recognition/intent.ts";
import type { ManagedCatalogBinding } from "../packages/recognition/provider-binding.ts";

export const recognitionOwner=privateKeyToAccount(`0x${"51".repeat(32)}`),otherOwner=privateKeyToAccount(`0x${"52".repeat(32)}`),
  reservationSigner=privateKeyToAccount(`0x${"73".repeat(32)}`);
export async function reservationFixture(options:{secondCreator?:typeof recognitionOwner;serviceDatabase?:(db:D1Database)=>D1Database}={}) {
  const mf=new Miniflare({modules:true,script:"export default {fetch(){throw Error('unused')}}",compatibilityDate:"2026-08-06",d1Databases:['DB']});
  const db=await mf.getD1Database('DB');
  const sql=await readFile(new URL('../packages/recognition/schema.sql',import.meta.url),'utf8');
  await db.batch(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE\s|$)/).map(v=>v.trim()).filter(Boolean).map(v=>db.prepare(v)));
  const namespace=hashText('fresh-two-community-catalog'),credentials={host:'identify-eu-west-1.acrcloud.com',accessKey:'fixture-key',accessSecret:'fixture-secret'},
    binding:ManagedCatalogBinding={schema:'pirate.managed-recognition-binding/1',namespace,catalogOrigin:'https://api-v2.acrcloud.com',bucketId:'123',projectId:'reviewed-fixture-project',
      identifyHost:credentials.host,accessKeySha256:hashJson({accessKey:credentials.accessKey}),associationEvidenceSha256:hashText('explicit simulated same-project association')},
    publicProfile={schema:'pirate.recognition-profile/1' as const,namespace,origin:'https://recognition.example',signer:reservationSigner.address.toLowerCase(),providerBindingSha256:hashJson(binding)},
    profile:RecognitionProfile={...publicProfile,sha256:hashJson(publicProfile)},journal={epoch:hashText('retained fixture journal epoch'),restoreAnchorSha256:hashText('explicit fresh empty fixture admission')};
  // Explicit fresh installation identity, not a ready recording/publication seed.
  await db.prepare('INSERT INTO shared_recognition_installation VALUES(?,?,?,?)').bind(namespace,profile.sha256,journal.epoch,journal.restoreAnchorSha256).run();
  const communities=new Map<string,CanonicalIntentPorts>(),wakes:RecognitionWake[]=[],files=new Map<string,Record<string,unknown>>(),
    flags={outage:false,indexing:false,lostIdentify:false,lostUpload:false,lostDelete:false,ambiguous:false,loseReserveAck:false,loseBindAck:false,loseCommitAck:false,unknownBeforeUpload:false},
    counts={identifies:0,uploads:0,deletes:0},requests:Array<ReturnType<Request["clone"]>>=[],withdrawn=new Set<string>();
  let runtime:ReturnType<typeof sharedRecognitionRuntime>;
  const transport=async(request:Request)=>{
    requests.push(request.clone());const path=new URL(request.url).pathname,response=await runtime.fetch(request);
    if((path==='/v1/reservations'&&flags.loseReserveAck)||(path.endsWith('/bind')&&flags.loseBindAck)||(path.endsWith('/commit')&&flags.loseCommitAck)) {
      flags.loseReserveAck=flags.loseBindAck=flags.loseCommitAck=false;throw Error('simulated lost central acknowledgement');
    }
    return response;
  };
  const a=await catalogCommunityFixture(profile,transport,{}, {ownerWallet:recognitionOwner.address}),
    registry=address(`0x${'8'.repeat(40)}`),b=await catalogCommunityFixture(profile,transport,{}, {ownerWallet:(options.secondCreator??recognitionOwner).address,
      publisherAccount:privateKeyToAccount(`0x${"62".repeat(32)}`),
      community:{communityId:communityId(6343,registry),registry,directory:a.configuration.directory,origin:'https://second-community.example'}});
  communities.set(a.configuration.communityId,a.canonicalPorts);communities.set(b.configuration.communityId,b.canonicalPorts);
  const provider={async request(request:Request) {
    const url=new URL(request.url);
    if(url.hostname.startsWith('identify-')) {
      counts.identifies++;
      if(flags.outage)return new Response(null,{status:503});
      if(flags.lostIdentify)throw Error('simulated unknown identify effect');
      const first=[...files.values()][0];
      return first&&!flags.indexing?Response.json({status:{code:0},metadata:{custom_files:[{acrid:first.acr_id},...(flags.ambiguous?[{acrid:'conflict'}]:[])]}}):Response.json({status:{code:1001}});
    }
    if(flags.outage)return new Response(null,{status:503});
    if(request.method==='POST') {
      counts.uploads++;
      if(flags.unknownBeforeUpload)throw Error('simulated crash after intent before upload effect');
      const form=await request.formData(),title=String(form.get('title')),
        row={id:counts.uploads,bucket_id:123,title,acr_id:`custom-${counts.uploads}`,state:1,user_defined:JSON.parse(String(form.get('user_defined')))};
      files.set(title,row);if(flags.lostUpload)throw Error('simulated upload effect before lost receipt');
      return Response.json({data:row});
    }
    if(request.method==='DELETE') {
      counts.deletes++;for(const [key,row]of files)if(String(row.id)===url.pathname.split('/').at(-1))files.delete(key);
      if(flags.lostDelete)throw Error('simulated lost delete receipt');return new Response(null,{status:204});
    }
    return Response.json({data:[...files.values()].filter(r=>r.title===url.searchParams.get('search')).map(r=>flags.indexing?{...r,state:0}:r),next_page_url:null});
  }};
  let nextSign:(()=>Promise<void>)|null=null;
  const signer:PrivateKeyAccount={...reservationSigner,async signTypedData(parameters) {const hook=nextSign;nextSign=null;await hook?.();return reservationSigner.signTypedData(parameters);}};
  const build=()=>sharedRecognitionRuntime({db:options.serviceDatabase?.(db)??db,profile,binding,credentials,catalogToken:'explicit-fixture-token',signer,communities,
    quotas:{service:100,community:60},journal,queue:{send:async message=>{wakes.push(message);}},providerTransport:provider,
    cancellation:async(ports,p)=>{
      const operation=await ports.db.withSession('first-primary').prepare("SELECT operation_id FROM external_operations WHERE job_id=? AND step='publication' AND prepared_json IS NOT NULL").bind(p.jobId).first();
      assert.equal(operation,null,'no signed posting may remain cancellable');return hashJson({cancelled:p.jobId,input:p.inputHash});
    },
    withdrawal:async(_ports,p)=>{
      assert.ok(withdrawn.has(p.communityId+":"+p.postId),"explicit simulated canonical chain withdrawal required");
      return hashJson({withdrawn:p.postId,revision:p.publicationRevision});
    }});
  runtime=build();
  const apps=[a,b].map((f,index)=>{
    const deployment={...firstSong,origin:f.configuration.app.origin,managedOrigin:f.ports.managed.origin,
      directoryProfile:{...firstSong.directoryProfile,communityId:f.configuration.communityId,registry:f.configuration.registry,directory:f.configuration.directory},
      posts:{...f.posts.profile,deploymentBlock:f.posts.profile.deploymentBlock.toString()}},queue:string[]=[],
      env={DB:f.community.db,MEDIA:f.community.media,JOBS:{send:async(m:{jobId:string})=>{queue.push(m.jobId);}},ASSETS:{fetch:async()=>new Response('fixture asset')},
        COMMUNITY_NAME:'Fixture',PLAN_ID:firstSong.planId,APPLICATION_PROFILE_HASH:hashText('fixture application'),COMMUNITY_PUBLISHER_PRIVATE_KEY:`0x${'11'.repeat(32)}`,OWNER_GRANT_JSON:JSON.stringify(f.grant)} as unknown as CommunityEnv,
      ports:CommunityDependencies={deployment,configuration:f.current,verifyLogin:verifyLoginOffline,creatorHealth:async()=>{throw Error('creator service forbidden');},releaseRuntime:()=>f.ports,
        publicReads:{client:f.posts.client,profile:f.posts.profile,transport:f.managed.service.pinTransport}},
      call=(path:string,init:RequestInit={})=>communityFetch(new Request(deployment.origin+path,init),env,ports);
    const signIn=async(account=index===1?(options.secondCreator??recognitionOwner):recognitionOwner)=>{
      const challenge=await (await call('/api/auth/challenge',{method:'POST',headers:{origin:deployment.origin,'content-type':'application/json'},body:JSON.stringify({address:account.address})})).json() as {id:string;message:string};
      const response=await call('/api/auth/verify',{method:'POST',headers:{origin:deployment.origin,'content-type':'application/json'},body:JSON.stringify({id:challenge.id,signature:await account.signMessage({message:challenge.message})})});
      assert.equal(response.status,200,await response.clone().text());
      const cookie=response.headers.get('set-cookie')!.split(';')[0]!,session=await (await call('/api/session',{headers:{cookie}})).json() as {csrf:string};
      return {cookie,write:(path:string,method:string,body:BodyInit,headers:Record<string,string>={})=>call(path,{method,body,headers:{cookie,origin:deployment.origin,'x-csrf-token':session.csrf,...headers}})};
    };
    return {f,env,ports,call,signIn,queue,async deliver(id:string){let outcome='';await communityQueue({messages:[{body:{jobId:id},ack:()=>{outcome='ack';},retry:()=>{outcome='retry';}} as unknown as Message<{jobId:string}>]},env,ports);return outcome;},
      recover:()=>communityScheduled(env,ports)};
  });
  return {db,profile,binding,communities,apps,wakes,flags,counts,requests,files,
    withdrawOnChain:(community:string,postId:string)=>{withdrawn.add(community+":"+postId);},
    fetch:transport,beforeSign:(hook:()=>Promise<void>)=>{nextSign=hook;},async deliverShared(){const message=wakes.shift();if(!message)return;await runtime.queue({messages:[{body:message,ack(){},retry(){wakes.push(message);}} as unknown as Message<RecognitionWake>]});},
    recoverShared:()=>runtime.scheduled(),restart:()=>{runtime=build();},
    dispose:async()=>{await a.dispose();await b.dispose();await mf.dispose();}};
}
export type ReservationFixture=Awaited<ReturnType<typeof reservationFixture>>;
