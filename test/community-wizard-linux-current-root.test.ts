// UNRUN: current entry/HTTP/model protocol coverage. Controlled ports here do
// not qualify native factory, HNS, VPS, provider or second-host acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createWizardServer} from "../apps/community-wizard/server/http.ts";
import {LinuxInputError} from "../packages/community-setup/shared-linux-profile.ts";
import {createLinuxClient,type LinuxCommand} from "../apps/community-wizard/src/linux-api.ts";
import {linuxFixture,fixtureCiphertext,fixtureKey} from "./community-wizard-linux-fixture.ts";
import {linuxLaunchOptions} from "../apps/community-wizard/server/linux-launch.ts";
async function mounted(t:import("node:test").TestContext){
 const f=await linuxFixture();t.after(f.dispose);
 const server=createWizardServer(undefined,"/unused-dist",{infisical:false,cloudflare:false},{linux:f.setup,
  authorizeLinux:async req=>{if(req.headers.cookie!=="fixture_operator=paired")throw new LinuxInputError("operator_pairing_required","Pair the original runner.");}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
 const a=server.address();assert.ok(a&&typeof a!=="string");const origin="http://127.0.0.1:"+a.port;
 const seen:Array<{path:string;credentials:RequestCredentials|undefined;headers:Headers;body:BodyInit|null|undefined}>=[];
 const transport:typeof fetch=(url,init)=>{
  assert.equal(typeof url,"string");assert.ok(String(url).startsWith("/api/linux/"));
  const headers=new Headers(init?.headers);headers.set("cookie","fixture_operator=paired");
  if(init?.method==="POST")headers.set("origin",origin);
  seen.push({path:String(url),credentials:init?.credentials,headers:new Headers(init?.headers),body:init?.body});
  return fetch(origin+String(url),{...init,headers});
 };
 return {f,server,origin,seen,client:createLinuxClient(transport)};
}
test("typed same-origin transport reaches real authenticated controller routes and preserves CSRF denial",async(t)=>{
 const {f,client,seen}=await mounted(t);const s=await client.state();assert.equal(s.available,true);
 if(!s.available)throw Error(s.correction);
 await client.send({action:"settings",input:{revision:s.state.revision,draft:f.draft}},s.csrf);
 assert.equal(f.setup.snapshot().draft?.version,2);assert.equal(seen.at(-1)?.path,"/api/linux/settings");
 assert.equal(seen.at(-1)?.credentials,"same-origin");assert.equal(seen.at(-1)?.headers.get("x-wizard-token"),s.csrf);
 const before=f.setup.snapshot();await assert.rejects(client.send({action:"inspect",input:{}}, "0".repeat(64)),/session expired/i);
 assert.deepEqual(f.setup.snapshot(),before);assert.equal(f.facts.nativeIntents.length,0);
 const calls=seen.length;await assert.rejects(client.request("https://foreign.example/other",{},s.csrf),/Unknown/);assert.equal(seen.length,calls);
});
test("ciphertext and separate recovery key use distinct actual typed endpoints without key persistence",async(t)=>{
 const {f,client,seen}=await mounted(t);let s=await client.state();assert.ok(s.available);
 if(!s.available)throw Error(s.correction);
 s=await client.send({action:"destination",input:{revision:s.state.revision,mode:"restore",target:{kind:"local-linux"}}},s.csrf);
 const file=new File([fixtureCiphertext],"fixture.enc",{type:"application/octet-stream"});
 s=await client.send({action:"backup",input:{},file},s.csrf);
 assert.equal(seen.at(-1)?.headers.get("content-type"),"application/octet-stream");
 assert.equal(seen.at(-1)?.headers.get("x-backup-size"),String(file.size));
 assert.equal(seen.at(-1)?.body,file);
 s=await client.send({action:"restore/inspect",input:{recoveryKey:fixtureKey}},s.csrf);
 assert.equal(seen.at(-1)?.path,"/api/linux/restore/inspect");
 assert.equal(seen.at(-1)?.headers.get("content-type"),"application/json");
 assert.ok(s.available&&s.state.restore);assert.ok(!(await f.disk()).includes(fixtureKey));
 assert.equal(f.facts.nativeIntents.length,0);
});
test("authentication failure and old model responses never become an unavailable or ready fallback",async(t)=>{
 const {origin}=await mounted(t);
 const unauth=createLinuxClient((url,init)=>fetch(origin+String(url),init));
 await assert.rejects(unauth.state(),/Pair/);
 const old=createLinuxClient(async()=>new Response(JSON.stringify({available:true,legacyAvailable:false,csrf:"a".repeat(64),
  state:{version:1},capabilities:{version:1}}),{headers:{"content-type":"application/json"}}));
 await assert.rejects(old.state(),/shared v2/);
});
test("current package command and main mount are connected; old app and theme remain present",async()=>{
 const main=await readFile("apps/community-wizard/src/main.tsx","utf8"),style=await readFile("apps/community-wizard/src/style.css","utf8");
 const manifest=JSON.parse(await readFile("apps/community-wizard/package.json","utf8"));
 assert.match(main,/WizardEntry cloudflare/);assert.match(main,/function App\(\)/);
 assert.match(main,/Deploy infrastructure/);assert.match(main,/LearningSetup/);assert.match(main,/ManagedServices/);
 assert.match(style,/\.wizard-modes/);assert.match(style,/\.linux-setup \.field select/);
 assert.equal(manifest.scripts.start,"tsx server/start.ts");assert.equal(manifest.scripts["start:linux"],"node --import tsx server/start-linux.ts");
 assert.equal(manifest.scripts["start:operator"],"node --import tsx server/start-operator.ts");
});
test("Linux launch parses only explicit private composition identity without importing or starting it",()=>{
 assert.deepEqual(linuxLaunchOptions(["--composition","/private/installed.mjs","--sha256","a".repeat(64)]),
  {composition:"/private/installed.mjs",sha256:"a".repeat(64)});
 assert.throws(()=>linuxLaunchOptions([]),/required/);
 assert.throws(()=>linuxLaunchOptions(["--composition","/private/a.mjs","--sha256","a".repeat(64),"--wallet","value"]),/arguments/);
});
// Compile-only contract negatives, never executed as requests.
const typedCommand:LinuxCommand={action:"inspect",input:{}};
void typedCommand;
if(false){
 // @ts-expect-error Unknown route is not a Linux command.
 const badRoute:LinuxCommand={action:"provider/admin",input:{}};
 // @ts-expect-error A deploy command needs the captured review/fingerprint fields.
 const badApproval:LinuxCommand={action:"deploy",input:{approved:true}};
 void badRoute;void badApproval;
}
