// Vendored from the pinned r24 notes-entry ISO; replay operation instrumentation is reviewable here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureDecodedSignal } from "./monitor.mjs";

const title = "Notes Climb and Fall";
const lyrics = "The notes climb.\nThe notes fall.";
const sha = bytes=>createHash("sha256").update(bytes).digest("hex");
const media = {
  master: { file:"master.mp3", sha256:"55f7a1315461cd219346fa36c9c14029b054770783315c1691106f9b494a58aa" },
  instrumental: { file:"instrumental.mp3", sha256:"5dbfd4613f0a3cecdfcea547c567c19997767bd1440780b177b62e0712d92db7" },
  vocals: { file:"vocals.mp3", sha256:"d67a5c0504881d6e7aca1e278db439bb9e276d0c12102d2091de2079bd107a5e" },
};
const masterUri = "ipfs://bafybeibl2kn2xd3yns5z56js5say4frriaaryvpsigztqt3xp5alq5igni";
const length = 384788;
const publicPost = /^0x[0-9a-f]{64}$/;
const submission = /^[a-f0-9-]{36}$/;
const utc = ()=>new Date().toISOString();

function remaining(options) {
  options.signal.throwIfAborted();
  const ms = options.cutoffMs-Date.now();
  assert(ms>0,"notes_fixture_valid_window_elapsed");
  return ms;
}

async function verifyPrivateInputs(options) {
  assert.match(options.origin,/^https:\/\/localhost:\d+$/);
  assert.equal(await realpath(options.mediaRoot),options.mediaRoot);
  assert.equal(await realpath(options.artifacts),options.artifacts);
  for (const path of [options.mediaRoot, options.artifacts]) {
    const dir = await lstat(path);
    assert(dir.isDirectory() && dir.uid===process.getuid() && !(dir.mode&0o077));
  }
  const paths = {};
  let masterPrefix = "";
  for (const [role,input] of Object.entries(media)) {
    const path=join(options.mediaRoot,input.file);
    const stat=await lstat(path);
    assert(stat.isFile() && stat.size===length && stat.uid===process.getuid() && !(stat.mode&0o077));
    assert.equal(await realpath(path),path);
    const body=await readFile(path);
    assert.equal(sha(body),input.sha256);
    paths[role]=path;
    if (role==="master") masterPrefix=sha(body.subarray(0,256));
  }
  return {paths,masterPrefix};
}

async function writeReceipt(options,name,record) {
  await writeFile(join(options.artifacts,name),
    JSON.stringify({schema:"pirate.disposable-native-notes-browser/1",...record},null,2)+"\n",
    {flag:"wx",mode:0o600});
}

async function scopedBrowser(page,options,mayPublish,run) {
  const counts = {authChallenge:0,authVerify:0,create:0,seal:0,audio:0,stems:0,blockedWrites:0,blockedCrossOrigin:0};
  let publicationArmed = false;
  let uploadId;
  const staged = new Set();
  const guard=async route=>{
    const request=route.request();
    const address=new URL(request.url()), method=request.method(), path=address.pathname;
    if (address.origin!==options.origin) {
      counts.blockedCrossOrigin++;
      return route.abort("blockedbyclient");
    }
    if (method==="GET" || method==="HEAD") return route.fallback();
    if (!options.signal.aborted && Date.now()<options.cutoffMs && mayPublish && !address.search) {
      if (path==="/api/auth/challenge" && method==="POST" && ++counts.authChallenge===1) return route.continue();
      if (path==="/api/auth/verify" && method==="POST" && ++counts.authVerify===1) return route.continue();
      if (publicationArmed && path==="/api/uploads" && method==="POST" && ++counts.create===1) return route.continue();
      if (publicationArmed && counts.create===1) {
        const part = /^\/api\/uploads\/([a-f0-9-]{36})\/(audio|stems\/(?:instrumental|vocals)|seal)$/.exec(path);
        if (part && (!uploadId || uploadId===part[1])) {
          const action=part[2], key=method+" "+action;
          uploadId=part[1];
          if (action==="audio" && method==="PUT" && !staged.has(key)) {
            staged.add(key);
            counts.audio++;
            return route.continue();
          }
          if (action.startsWith("stems/") && ["POST","PUT"].includes(method) && !staged.has(key)) {
            staged.add(key);
            counts.stems++;
            return route.continue();
          }
          if (action==="seal" && method==="POST" && counts.audio===1 && counts.stems===4 && ++counts.seal===1)
            return route.continue();
        }
      }
    }
    counts.blockedWrites++;
    return route.abort("blockedbyclient");
  };
  await page.route("**/*",guard);
  try { return await run(counts,()=>{ publicationArmed=true; }); }
  finally { await page.unroute("**/*",guard); }
}

async function getJson(page,options,path) {
  const timeout = Math.min(remaining(options),10000);
  return page.evaluate(async ({path,timeout})=>{
    const response=await fetch(path,{cache:"no-store",signal:AbortSignal.timeout(timeout)});
    return {status:response.status,body:response.ok ? await response.json() : null};
  },{path,timeout});
}

async function ensureInstalledOrigin(page,options) {
  assert.equal(new URL(page.url()).origin,options.origin);
  assert(await page.evaluate(()=>window.isSecureContext));
  const boot=await getJson(page,options,"/.well-known/pirate-client.json");
  if (boot.status!==200) throw Object.assign(Error("installed_origin_http_"+boot.status),{httpStatus:boot.status});
  assert.equal(boot.body.schema,"pirate.community-client-config/1");
  assert.equal(boot.body.canonicalOrigin,options.origin);
  assert(boot.body.fixture!==true);
  assert.match(boot.body.communityId,publicPost);
  return boot.body.communityId;
}

async function installedPublishingReady(page,options) {
  const bound=Math.min(Date.now()+15000,options.cutoffMs);
  for (;;) {
    const reply=await getJson(page,options,"/api/capabilities");
    if (reply.status!==200) throw Object.assign(Error("installed_capabilities_http_"+reply.status),{httpStatus:reply.status});
    assert.equal(reply.body.schema,"pirate.community-capabilities/1");
    if (reply.body.upload===true && reply.body.publication===true)
      return {status:200,upload:true,publication:true,policyVersion:reply.body.policyVersion};
    assert(Date.now()+500<bound,"installed_grant_or_managed_readiness_unproved");
    await page.waitForTimeout(500);
  }
}

async function publicIdentity(page,options,postId) {
  const reply=await getJson(page,options,"/api/public/posts/"+postId+"/proof");
  if (reply.status!==200) return {status:reply.status};
  const {post,transactionHash,blockNumber,schema}=reply.body;
  assert.equal(schema,"pirate.community-publication-proof/1");
  assert.equal(post.postId,postId);
  assert.equal(post.title,title);
  assert.match(post.communityId,publicPost);
  assert.match(transactionHash,publicPost);
  const audio=post.media.find(value=>value.role==="audio");
  assert.equal(audio.uri,masterUri);
  assert.equal(audio.sha256,"0x"+media.master.sha256);
  assert.equal(audio.byteLength,length);
  return {status:200,postId,communityId:post.communityId,title,transactionHash,blockNumber,
    pinUri:audio.uri,masterSha256:audio.sha256,byteLength:audio.byteLength};
}

async function waitForPublication(page,options,postId) {
  const bound=Math.min(Date.now()+240000,options.cutoffMs-190000);
  assert(Date.now()<bound,"no_publication_window_before_restart_reserve");
  for (;;) {
    const result=await publicIdentity(page,options,postId);
    if (result.status===200) return result;
    assert([404,503].includes(result.status),"unexpected_public_proof_http_"+result.status);
    assert(Date.now()+1000<bound,"one_original_publication_unconfirmed_http_"+result.status);
    await page.waitForTimeout(1000);
  }
}

async function observePlayer(page,options,expected,masterPrefix,trace=async(_name,run)=>run()) {
  const playerPath="/#song-"+expected.postId;
  const navigation=await trace("player-navigation",async()=>{
    const reply=await page.goto(options.origin+playerPath,{waitUntil:"domcontentloaded",timeout:Math.min(15000,remaining(options))});
    // A navigation within the same document may only change the fragment.
    if (reply) assert.equal(reply.status(),200);
    return reply;
  });
  await trace("verify-origin",async()=>{
    assert.equal(await ensureInstalledOrigin(page,options),expected.communityId);
  });
  await trace("activate-player",()=>page.getByRole("button",{name:"Play "+title,exact:true}).click({timeout:Math.min(15000,remaining(options))}));
  const element=page.locator('[data-song-player="'+expected.postId+'"] audio');
  await trace("wait-player-element",()=>element.waitFor({state:"attached",timeout:Math.min(8000,remaining(options))}));
  return captureAndMatch(element,options,expected,masterPrefix,trace);
}

async function captureAndMatch(element,options,expected,masterPrefix,trace=async(_name,run)=>run()) {
  const analysis=await trace("decode-audio",()=>element.evaluate(captureDecodedSignal,{}));
  if (!analysis.ok) return {analysis};
  const timeout=Math.min(10000,remaining(options));
  const sourceParts=await trace("verify-range-readback",()=>element.evaluate(async (audio,timeout)=>{
    const source=new URL(audio.currentSrc);
    if (source.protocol!=="https:" || source.origin!==location.origin || source.search)
      throw Error("unexpected_player_source");
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),
      b=>b.toString(16).padStart(2,"0")).join("");
    const partial=await fetch(source,{cache:"no-store",signal:AbortSignal.timeout(timeout),headers:{Range:"bytes=0-255"}});
    const sample=await partial.arrayBuffer();
    return {path:source.pathname,status:partial.status,sample:sample.byteLength,sampleDigest:await hash(sample),
      mime:partial.headers.get("content-type"),contentRange:partial.headers.get("content-range")};
  },timeout));
  const fullParts=await trace("verify-full-body-readback",()=>element.evaluate(async (audio,timeout)=>{
    const source=new URL(audio.currentSrc);
    if (source.protocol!=="https:" || source.origin!==location.origin || source.search)
      throw Error("unexpected_player_source");
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),
      b=>b.toString(16).padStart(2,"0")).join("");
    const whole=await fetch(source,{cache:"no-store",signal:AbortSignal.timeout(timeout)});
    const body=await whole.arrayBuffer();
    return {status:whole.status,digest:await hash(body),total:body.byteLength};
  },timeout));
  const wire={path:sourceParts.path,full:fullParts.status,range:sourceParts.status,digest:fullParts.digest,
    total:fullParts.total,sample:sourceParts.sample,sampleDigest:sourceParts.sampleDigest,
    mime:sourceParts.mime,contentRange:sourceParts.contentRange};
  await trace("verify-audio-wire",async()=>{
    assert.deepEqual(wire,{path:"/api/public/posts/"+expected.postId+"/audio",full:200,range:206,
      digest:media.master.sha256,total:length,sample:256,sampleDigest:masterPrefix,mime:"audio/mpeg",
      contentRange:"bytes 0-255/"+length});
  });
  return {analysis,wire,humanAudibilityObserved:false};
}

export async function publishNativeNotes(page,options) {
  // Reserve time for the one publication, genuine foreground restart, and public replay.
  assert(remaining(options)>420000,"insufficient_signed_window_for_notes_and_restart");
  const input=await verifyPrivateInputs(options);
  const record={phase:"bootstrap",startedUtc:utc(),origin:options.origin};
  await writeReceipt(options,"w6-native-notes-publish-start.json",record);
  try {
    return await scopedBrowser(page,options,true,async (counts,arm)=>{
      record.counts=counts;
      const communityId=await ensureInstalledOrigin(page,options);
      record.publishingReady=await installedPublishingReady(page,options);
      await page.getByRole("button",{name:"Sign in",exact:true}).first().click({timeout:12000});
      await page.locator('button[data-community-post-slot]').waitFor({state:"visible",timeout:18000});
      record.phase="baseline";
      const session=await getJson(page,options,"/api/session");
      assert(session.status===200 && session.body.publisher===true);
      const prior=await getJson(page,options,"/api/uploads");
      assert.equal(prior.status,200);
      assert.equal(prior.body.uploads.length,0);
      record.phase="composer";
      await page.locator('button[data-community-post-slot]').click();
      const composer=page.getByRole("main",{name:"Create a post",exact:true});
      const next=composer.getByRole("button",{name:"Next",exact:true});
      await composer.getByLabel("Upload audio",{exact:true}).setInputFiles(input.paths.master,{timeout:15000});
      await composer.locator("#song-stem-instrumental").setInputFiles(input.paths.instrumental);
      await composer.locator("#song-stem-vocals").setInputFiles(input.paths.vocals);
      await composer.locator("#song-track-title").fill(title);
      const lyricField=composer.locator("#song-lyrics");
      await lyricField.fill(lyrics);
      await lyricField.press("Tab");
      await next.click();
      await composer.getByRole("heading",{name:"Release policy",exact:true}).waitFor();
      const rights=composer.getByRole("checkbox",{name:"I have the rights needed to publish this recording and accept the community release policy.",exact:true});
      assert(!(await rights.isChecked()));
      await rights.press("Space");
      assert(await rights.isChecked());
      const safeRating=composer.getByRole("radio",{name:"General",exact:true});
      if (await safeRating.count()) await safeRating.press("Space");
      const noDerivatives=composer.getByRole("radio",{name:"Do not allow derivative use",exact:true});
      if (await noDerivatives.count()) await noDerivatives.press("Space");
      record.consentUtc=utc();
      record.syntheticOperator=true;
      await next.click();
      record.phase="single_seal";
      assert(remaining(options)>405000,"insufficient_remaining_window_before_seal");
      arm();
      const sealed=page.waitForResponse(response=>response.request().method()==="POST"&&
        /^\/api\/uploads\/[a-f0-9-]{36}\/seal$/.test(new URL(response.url()).pathname),{timeout:40000});
      const [,response]=await Promise.all([composer.getByRole("button",{name:"Post",exact:true}).click(),sealed]);
      assert.equal(response.status(),202,"original_seal_not_accepted");
      const {postId,jobId}=await response.json();
      assert.match(postId,publicPost);
      assert.equal(counts.seal,1);
      const submissionId=new URL(response.url()).pathname.split("/")[3];
      assert.match(submissionId,submission);
      assert.equal(jobId,"publication:"+submissionId);
      record.original={postId,jobId,submissionId,sealUtc:utc()};
      await writeReceipt(options,"w6-native-notes-original.json",record);
      record.phase="wait_for_same_published_original";
      const proof=await waitForPublication(page,options,postId);
      assert.equal(proof.communityId,communityId);
      record.publishedUtc=utc();
      const {body:list,status}=await getJson(page,options,"/api/uploads");
      assert.equal(status,200);
      assert.equal(list.uploads.length,1);
      assert.equal(list.uploads[0].postId,postId);
      assert.equal(list.uploads[0].jobId,jobId);
      record.phase="play_before_ordinary_restart";
      record.playback=await observePlayer(page,options,proof,input.masterPrefix);
      assert(record.playback.analysis.ok,"decoded_capture_before_restart_failed");
      assert.equal(counts.authChallenge,1);
      assert.equal(counts.authVerify,1);
      assert.equal(counts.create,1);
      assert.equal(counts.audio,1);
      assert.equal(counts.stems,4);
      assert.equal(counts.seal,1);
      assert.equal(counts.blockedWrites,0);
      record.proof=proof;
      remaining(options);
      record.endedUtc=utc();
      await writeReceipt(options,"w6-native-notes-before.json",record);
      return {...record.original,proof,masterPrefix:input.masterPrefix};
    });
  } catch (error) {
    await writeReceipt(options,"w6-native-notes-before-failed.json",{...record,endedUtc:utc(),
      error:{name:error.name,message:error.message}});
    throw error;
  }
}

export async function replayNativeNotes(page,options,original) {
  assert(remaining(options)>15000,"insufficient_signed_window_for_replay");
  const record={phase:"public_read_only_replay",startedUtc:utc(),original};
  try {
    return await scopedBrowser(page,options,false,async counts=>{
      record.counts=counts;
      const trace=async(name,run)=>{
        const started=Date.now();
        record.operation={name,event:"enter",utc:utc()};
        try {
          const value=await run();
          record.operation={name,event:"return",utc:utc(),elapsedMs:Date.now()-started};
          record.lastCompletedOperation=name;
          return value;
        } catch(error) {
          record.operation={name,event:"throw",utc:utc(),elapsedMs:Date.now()-started,errorClass:error?.name??"unknown",...(Number.isInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?{httpStatus:error.httpStatus}:{})};
          throw error;
        }
      };
      await trace("verify-origin",async()=>{
        assert.equal(await ensureInstalledOrigin(page,options),original.proof.communityId);
      });
      record.publishingReady=await trace("read-capabilities",async()=>{
        const ready=await installedPublishingReady(page,options);
        assert.deepEqual(ready,original.publishingReady);
        return ready;
      });
      const proof=await trace("read-public-proof",async()=>{
        const current=await publicIdentity(page,options,original.postId);
        if (current.status!==200) throw Object.assign(Error("unexpected_public_proof_http_"+current.status),{httpStatus:current.status});
        assert.deepEqual(current,original.proof);
        return current;
      });
      record.playback=await observePlayer(page,options,proof,original.masterPrefix,trace);
      await trace("validate-decoded-audio",async()=>{
        assert(record.playback.analysis.ok,"decoded_capture_after_restart_failed");
      });
      await trace("verify-read-only-effects",async()=>{
        assert.equal(counts.blockedWrites,0);
        assert.equal(counts.authChallenge+counts.authVerify+counts.create+counts.seal+counts.audio+counts.stems,0);
      });
      record.proof=proof;
      remaining(options);
      record.endedUtc=utc();
      await writeReceipt(options,"w6-native-notes-after.json",record);
      return record;
    });
  } catch (error) {
    await writeReceipt(options,"w6-native-notes-after-failed.json",{...record,endedUtc:utc(),
      error:{name:error.name,message:error.message}});
    throw error;
  }
}
