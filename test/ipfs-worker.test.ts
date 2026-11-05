import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { preparePin } from "../packages/community/ipfs.ts";
import { canonical } from "../packages/community/common.ts";

test("compiled IPFS reader recomputes the pinned configuration root inside workerd", async()=>{
  const deployed=JSON.parse(await readFile("docs/deployments/first-song-managed-20261105.configuration.json","utf8")),
    bytes=new TextEncoder().encode(canonical(deployed.configuration)), expected=await preparePin(bytes,"application/json"),
    source=`import {preparePin,fetchPublicIpfs} from './packages/community/ipfs.ts';
      const text=${JSON.stringify(canonical(deployed.configuration))}, expected=${JSON.stringify(expected)};
      export default {async fetch(){let phase='importer';try{
        const computed=await preparePin(new TextEncoder().encode(text),'application/json');
        phase='fetch';const fetched=await fetchPublicIpfs(expected.uri,expected.sha256,65536);
        return Response.json({computed,gateway:fetched.gateway,bytes:fetched.bytes.length});
      }catch(error){return Response.json({phase,name:error.name,code:error.code,message:error.message},{status:500})}}};`,
    output=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:"explicit-ipfs-worker-fixture.ts"},bundle:true,write:false,platform:"browser",format:"esm",target:"es2024",external:["node:*"],minify:true,logLevel:"silent"});
  let calls=0;
  const mf=new Miniflare({modules:true,script:output.outputFiles[0]!.text,compatibilityDate:"2026-08-06",compatibilityFlags:["nodejs_compat"],outboundService:async(request:{url:string})=>{calls++;assert.equal(request.url,`https://gateway.pinata.cloud/ipfs/${expected.uri.slice(7)}`);return new Response(bytes,{headers:{"content-type":"application/json"}})}});
  try{const response=await mf.dispatchFetch("https://fixture.example/");const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.deepEqual(result,{computed:expected,gateway:"https://gateway.pinata.cloud",bytes:bytes.length});assert.equal(calls,1)}finally{await mf.dispose()}
});
