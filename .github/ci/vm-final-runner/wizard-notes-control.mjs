// Vendored from the pinned r24 notes-entry ISO; retained-repair progress instrumentation is reviewable here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const codes = new Set([
  "configuration_event_mismatch", "configuration_history_conflict", "configuration_history_missing",
  "configuration_not_canonical", "directory_binding_changed", "directory_chain_reorganized",
  "directory_code_changed", "directory_not_confirmed", "directory_query_clock_regressed",
  "directory_state_event_mismatch", "directory_verification_snapshot_mismatch", "install_directory_unavailable",
  "invalid_directory_configuration", "managed_admission_unavailable", "managed_configuration_changed",
  "managed_credential_unavailable", "managed_custody_unavailable", "managed_installed_inputs_unavailable",
  "managed_issuer_unavailable", "managed_original_conflict", "managed_original_unavailable",
  "managed_profile_unavailable", "managed_scope_changed", "managed_service_configuration_unavailable",
  "managed_service_refused", "managed_service_response_invalid", "managed_service_transport_unknown",
  "managed_service_unavailable", "origin_configuration_event_missing", "origin_event_provenance_changed",
  "original_install_registration_not_safe", "original_install_transaction_mismatch", "original_install_transaction_unavailable",
  "publisher_custody_binding_unavailable", "unadmitted_install_deployment", "web2_managed_grant_admission_unavailable",
  "web2_publishing_authority_unavailable", "web2_setup_unavailable", "wrong_application_chain",
]);
const installationPrepareCodes = new Set([
  "install_authority_expired_during_read", "install_chain_reorganized", "install_current_authority_changed",
  "install_posts_source_changed", "public_ipfs_unavailable", "safe_registration_required",
  "web2_installation_context_changed", "web2_installation_unavailable", "web2_original_practice_selection_changed",
  "web2_pairing_only", "web2_private_practice_selection_invalid", "web2_private_study_unavailable",
  "web2_publishing_attachment_required", "web2_revision_changed", "web2_signing_original_unreadable",
]);
const installationPreparePath = "/api/web2/installation-prepare";
const installFixtureWaitMs = 1800000;
const installContinuationReserveMs = 90000;
const installWorkerReserveMs = 40000;
const installedFetchCapMs = 180000;
const defaultWizardClickMs = 15000;
const nsPerMs = 1000000n;

function installationObservationWindow(now, phaseDeadline, cutoff, monoNow, phaseMonoDeadline) {
  assert(Number.isSafeInteger(phaseDeadline) && Number.isSafeInteger(cutoff));
  assert(phaseDeadline <= cutoff - installWorkerReserveMs, "install_phase_deadline_outside_worker");
  const monoRemainingMs = Number((phaseMonoDeadline - monoNow) / nsPerMs);
  const phaseRemainingMs = Math.min(phaseDeadline - now, monoRemainingMs);
  const workerRemainingMs = cutoff - now;
  assert(monoRemainingMs <= 1860000 && phaseRemainingMs <= 1860000 &&
    workerRemainingMs <= 5400000, "install_observation_clock_changed");
  const stopAt = Math.min(now + installFixtureWaitMs,
    phaseDeadline - installContinuationReserveMs, cutoff - installWorkerReserveMs);
  const phaseReserveNs = phaseMonoDeadline - BigInt(installContinuationReserveMs) * nsPerMs;
  const waitLimitNs = monoNow + BigInt(stopAt - now) * nsPerMs;
  const monoStopAt = phaseReserveNs < waitLimitNs ? phaseReserveNs : waitLimitNs;
  assert(stopAt > now && monoStopAt > monoNow, "install_observation_time_unavailable");
  return {stopAt, monoStopAt, phaseRemainingMs, workerRemainingMs};
}

function observationRemainingMs(window, monoNow) {
  return Math.min(window.stopAt - Date.now(), Number((window.monoStopAt - monoNow) / nsPerMs));
}

function isInstallationRequest(request, origin, path=installationPreparePath) {
  return request.method() === "POST" && request.url() === origin + path &&
    request.redirectedFrom() === null;
}

async function observeInstallationPost(page, origin, button, window, capture) {
  const monoStarted = process.hrtime.bigint();
  const waitMs = observationRemainingMs(window,monoStarted);
  assert(waitMs > 0, "install_observation_time_unavailable");
  const monoEnd = monoStarted + BigInt(waitMs) * nsPerMs;
  const client = {
    requestCount: 0, requestFailed: false, clickCompleted: false, elapsedMs: 0, waitMs,
    phaseRemainingMs: window.phaseRemainingMs, workerRemainingMs: window.workerRemainingMs,
    productFetchCapMs: installedFetchCapMs, clickCapMs: defaultWizardClickMs,
  };
  let original, responseStatus = null;
  const current = () => Date.now() < window.stopAt && process.hrtime.bigint() < monoEnd;
  const requested = request => {
    if (!current() || !isInstallationRequest(request,origin) || request === original) return;
    if (client.requestCount === 0) original = request;
    client.requestCount = Math.min(2, client.requestCount + 1);
  };
  const failed = request => { if (current() && request === original) client.requestFailed = true; };
  page.on("request",requested);
  page.on("requestfailed",failed);
  try {
    const response = page.waitForResponse(reply => current() && client.requestCount === 1 &&
      reply.url() === origin + installationPreparePath && reply.request() === original,
      {timeout:waitMs}).then(reply => {
        const status = reply.status();
        if (current() && client.requestCount === 1 && Number.isInteger(status) && status >= 100 && status <= 599)
          responseStatus = status;
        return reply;
      });
    void response.catch(() => {}); // A pre-click deadline refusal still closes this waiter.
    const clickRemainingMs = observationRemainingMs({stopAt:window.stopAt,monoStopAt:monoEnd},process.hrtime.bigint());
    assert(clickRemainingMs > 0, "install_observation_time_unavailable_before_click");
    const click = button.click({timeout:Math.min(defaultWizardClickMs,clickRemainingMs)})
      .then(() => { client.clickCompleted = true; });
    const [reply] = await Promise.all([response,click]);
    assert(current() && client.requestCount === 1 && responseStatus !== null,"install_observation_unmatched");
    return reply;
  } finally {
    page.off("request",requested);
    page.off("requestfailed",failed);
    client.elapsedMs = Number((process.hrtime.bigint() - monoStarted) / nsPerMs);
    capture(client,client.requestCount === 1 ? responseStatus : null);
  }
}

async function observePostPlanAction(page,origin,path,button,timeout,phaseWindow,capture) {
  const monoStarted=process.hrtime.bigint();
  const localMonoEnd=monoStarted+BigInt(timeout)*nsPerMs;
  const window={
    stopAt:Math.min(Date.now()+timeout,phaseWindow.stopAt),
    monoStopAt:localMonoEnd<phaseWindow.monoStopAt?localMonoEnd:phaseWindow.monoStopAt,
  };
  const remaining=()=>observationRemainingMs(window,process.hrtime.bigint());
  const current=()=>Date.now()<window.stopAt && process.hrtime.bigint()<window.monoStopAt;
  const waitMs=remaining();
  assert(waitMs>0,"install_request_observation_time_unavailable");
  let original, requestCount=0, status=null, clickStarted=false;
  const exactPath="/api/web2/"+path;
  const requested=request=>{
    if (!clickStarted || request===original || !isInstallationRequest(request,origin,exactPath) || !current()) return;
    if (requestCount===0) original=request;
    requestCount=Math.min(2,requestCount+1);
  };
  page.on("request",requested);
  try {
    const response=page.waitForResponse(reply=>current() && requestCount===1 &&
      reply.request()===original && reply.url()===origin+exactPath,{timeout:waitMs});
    void response.catch(()=>{}); // A pre-click refusal still closes the browser waiter.
    const clickRemainingMs=remaining();
    assert(clickRemainingMs>0,"install_request_observation_time_unavailable_before_click");
    clickStarted=true;
    const [reply]=await Promise.all([response,button.click({timeout:Math.min(defaultWizardClickMs,clickRemainingMs)})]);
    const code=reply.status();
    assert(current() && requestCount===1 && Number.isInteger(code) && code>=100 && code<=599,
      "install_request_observation_unmatched");
    status=code;
    return reply;
  } finally {
    page.off("request",requested);
    capture(requestCount,requestCount===1?status:null);
  }
}

function armWizardPrepareObserver({origin,armBy,stopAt,allowedCodes,forInstallation=false}) {
  const key=forInstallation?"__pirateInstallationPrepareRefusal":"__piratePublishingPrepareRefusal";
  if (window.location.origin!==origin || Date.now()>=armBy ||
      Date.now()>=stopAt || Object.hasOwn(window,key)) return false;
  const path=forInstallation?"/api/web2/installation-prepare":"/api/web2/publishing-prepare";
  const originalFetch=window.fetch;
  const knownCodes=new Set(allowedCodes), maximumBytes=1024;
  let resolve, settled=false, timer, reader;
  const result=new Promise(done=>{resolve=done;});
  const restore=()=>{if (window.fetch===observeFetch) window.fetch=originalFetch;};
  const finish=(outcome)=>{
    if (settled) return;
    settled=true;
    clearTimeout(timer);
    restore();
    if (reader) void reader.cancel().catch(()=>{});
    resolve(outcome);
  };
  const skip=captureSkip=>finish({captureSkip});
  async function observe(response) {
    const captureMs=Math.min(250,stopAt-Date.now());
    if (settled || captureMs<=0) return skip("observer-deadline");
    const statusMatches=forInstallation?response.status>=400 && response.status<=599:response.status===503;
    if (!statusMatches || response.url!==origin+path || response.redirected) return skip("response-mismatch");
    if (response.headers.get("content-type")!=="application/json") return skip("unexpected-content-type");
    const monotonicEnd=performance.now()+captureMs;
    const current=()=>!settled && performance.now()<monotonicEnd && Date.now()<stopAt;
    clearTimeout(timer);
    timer=setTimeout(()=>skip("observer-deadline"),captureMs);
    try {
      reader=response.clone().body?.getReader();
      if (!reader) return skip("stream-unavailable");
      const bytes=new Uint8Array(maximumBytes);
      let size=0;
      while (current()) {
        const {done,value}=await reader.read();
        if (!current()) break;
        if (done) {
          try {
            const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,size)));
            if (typeof envelope?.code==="string" && knownCodes.has(envelope.code)) {
              finish(forInstallation?{responseCode:envelope.code,observedStatus:response.status}:{responseCode:envelope.code});
            } else skip("no-allowlisted-code");
          } catch { skip("no-allowlisted-code"); }
          return;
        }
        if (!(value instanceof Uint8Array)) return skip("stream-unavailable");
        if (value.byteLength>maximumBytes-size) return skip("body-too-large");
        bytes.set(value,size);
        size+=value.byteLength;
      }
      skip("observer-deadline");
    } catch {
      skip("stream-unavailable");
    } finally {
      reader?.releaseLock();
    }
  }
  function observeFetch(input,init) {
    const matches=!settled && window.location.origin===origin && input===path &&
      init?.method==="POST" && init.credentials==="same-origin" && init.cache==="no-store";
    if (matches) {
      restore();
      if (Date.now()>=stopAt) skip("observer-deadline");
    }
    const original=Reflect.apply(originalFetch,this,arguments);
    if (matches && !settled) void original.then(observe).catch(()=>skip("stream-unavailable"));
    return original;
  }
  Object.defineProperty(window,key,{value:result,configurable:true});
  window.fetch=observeFetch;
  timer=setTimeout(()=>skip("observer-deadline"),Math.max(0,stopAt-Date.now()));
  return true;
}

async function boundedObserverCall(operation,cutoff) {
  const deadline=Number(cutoff)-40000;
  const captureMs=Math.min(250,deadline-Date.now());
  if (captureMs<=0) return null;
  const monotonicEnd=performance.now()+captureMs;
  let timer;
  try {
    const value=await Promise.race([
      operation(captureMs,deadline),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(null),captureMs);}),
    ]);
    return Date.now()<deadline && performance.now()<monotonicEnd ? value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const [step,root,checkout,runId,cutoff,...extra]=process.argv.slice(2);
const allowedSteps=["hold-registration","fund-original","install-original","retained-repair"];
assert(allowedSteps.includes(step) && extra.length===0);
assert.equal(root,"/opt/pw2-rehearsal");
assert.equal(checkout,"/opt/pw2-machine-source/checkout");
assert.match(runId,/^manual-[a-f0-9]{12}$/);
assert.match(cutoff,/^\d{13}$/);
assert.equal(process.getuid(),1000);
const now=()=>new Date().toISOString();
const sha=value=>createHash("sha256").update(value).digest("hex");
async function privateRead(path,subphases) {
  if (subphases) stage=subphases[0];
  assert.equal(await realpath(path),path);
  if (subphases) stage=subphases[1];
  const info=await lstat(path);
  assert(info.isFile() && info.uid===1000 && !(info.mode&0o077) && info.size>0 && info.size<=16*1024*1024);
  return JSON.parse(await readFile(path,"utf8"));
}
const launch=await privateRead(join(root,"manual-run-original.json"));
assert.equal(launch.source,"c99644d870e92f465a396f42497d203913a55e58");
assert.equal(launch.installationId,"rehearsal-"+runId);
assert.equal(launch.state,join(root,"host"));
assert.equal(launch.artifacts,join(root,"artifacts",runId));
let raw="";
for await (const chunk of process.stdin) {
  raw+=chunk;
  assert(raw.length<8192);
}
const handoff=JSON.parse(raw);
raw="";
assert.match(handoff.wizard,/^http:\/\/127\.0\.0\.1:\d+\/\?setup=linux-web2$/);
assert.match(handoff.communityOrigin,/^https:\/\/localhost:\d+$/);
assert.match(handoff.fixtureOwner,/^0x[a-fA-F0-9]{40}$/);
const fresh=step==="hold-registration", restarted=step==="retained-repair";
if (fresh) assert.match(handoff.fixtureInvitation,/^[a-f0-9]{64}$/);
else assert.equal(handoff.fixtureInvitation,undefined);
if (fresh||restarted) assert.match(handoff.pairingCode,/^[A-Za-z0-9_-]{43}$/);
const artifactDir=restarted?join(launch.artifacts,"reopened"):launch.artifacts;
const cdp=await privateRead(join(artifactDir,"wizard-browser-control.json"));
assert.equal(cdp.controlLabel,"wizard");
assert.match(cdp.webSocket,/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]{36}$/);
const wizardOrigin=new URL(handoff.wizard).origin;
const { chromium }=await import(pathToFileURL(join(checkout,"apps/community-wizard/node_modules/playwright-core/index.mjs")).href);
const record={schema:"pirate.disposable-native-wizard-browser/1",step,startedUtc:now(),fixtureWallet:true,phases:[]};
let stage="connect-browser";
const progressPath=join(artifactDir,"w6-wizard-"+step+"-progress.json");
function writeProgress() {
  try {
    const temporary=progressPath+".tmp";
    writeFileSync(temporary,JSON.stringify({...record,stage,writtenUtc:now()},null,2)+"\n",{mode:0o600});
    renameSync(temporary,progressPath);
  } catch { /* Diagnostic capture never changes the rehearsal outcome. */ }
}
async function operation(name,run) {
  record.waiting={operation:name,utc:now()};
  stage=name;
  writeProgress();
  const value=await run();
  delete record.waiting;
  record.lastCompleted={operation:name,utc:now()};
  writeProgress();
  return value;
}
writeProgress();
const browser=await operation("connect-cdp",()=>chromium.connectOverCDP(cdp.webSocket,{timeout:8000}));
let publishingPrepareStatus=null, publishingObserverPage=null;
let installationPrepareStatus=null, installationObserverPage=null, installationClient=null;
let postPlanRequestCount=null, postPlanResponseStatus=null;
const postPlanActions=new Set(["install","installation-status"]);
const postPlanStages=new Set([
  "install-planned-journal","install-planned-original","install-plan-draft","install-review-checkbox",
  "install-budget","install-request","install-response","install-status-decision-journal",
  "installation-status-budget","installation-status-request","installation-status-response",
  "install-final-journal","install-final-original","install-running-observation","install-running-indicator",
  "install-signing-read","install-signing-attachment","install-receipt-fields","install-final-budget",
]);
const postPlanRequestStages=new Set(["install-request","install-response","installation-status-request","installation-status-response"]);
const installationPrepareStages=new Set([
  "installation-prepare-attached-indicator","installation-prepare-budget",
  "installation-prepare-request","installation-prepare-response",
]);
function mark(label,info={}) {
  stage=label;
  record.phases.push({label,utc:now(),...info});
  writeProgress();
}
function budget(ms=0) {
  const value=Number(cutoff)-Date.now();
  assert(value>ms,"host_cutoff_or_reserve");
  return value;
}
const journal=subphases=>privateRead(join(launch.state,"wizard","web2-wizard-original.json"),subphases);
const signing=()=>privateRead(join(launch.state,"wizard","web2-signing-sidecar.json"));
function original(saved,diagnose=false) {
  if (diagnose) stage="check-original-origin-controller";
  assert(saved.request?.origin===handoff.communityOrigin && saved.request.controller.toLowerCase()===handoff.fixtureOwner.toLowerCase());
  if (diagnose) stage="check-original-prepared";
  assert(saved.prepared?.enrollmentId && Number.isSafeInteger(saved.prepared.expiresAt));
  return {enrollmentId:saved.prepared.enrollmentId, preparedSha256:sha(JSON.stringify(saved.prepared)),
    controllerSignatureSha256:saved.controllerSignature?sha(saved.controllerSignature):null,
    registrationExpiresAt:saved.prepared.expiresAt};
}
const checkedBefore=subphases=>privateRead(join(launch.artifacts,"w6-wizard-hold-registration.json"),subphases);
function eachOriginal(saved,pinned,diagnose=false) {
  const current=original(saved,diagnose);
  if (diagnose) stage="check-original-continuity";
  assert.deepEqual(current,pinned);
}
function registrationWindow(saved) {
  budget();
  assert(Date.now()<saved.prepared.expiresAt*1000,"fixture_registration_expired");
}
try {
  if (step==="install-original") stage="select-wizard-page";
  const matches=browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url().startsWith(wizardOrigin+"/"));
  assert.equal(matches.length,1);
  const page=matches[0];
  page.setDefaultTimeout(defaultWizardClickMs);
  const button=name=>page.getByRole("button",{name,exact:true});
  const state=value=>page.getByText("Setup state: "+value,{exact:true});
  const check=name=>page.getByRole("checkbox",{name,exact:true}).check();
  // Only the owned UI sends its requests. This listener observes one exact action.
  async function action(label,path,{popup=false,held=false,timeout=50000,phaseWindow}={}) {
    if (step==="install-original" && postPlanActions.has(path)) {
      stage=path+"-budget";
      budget();
      const waitMs=Math.min(timeout,budget());
      stage=path+"-request";
      postPlanRequestCount=0;
      postPlanResponseStatus=null;
      const reply=await observePostPlanAction(page,wizardOrigin,path,button(label),waitMs,phaseWindow,(count,status)=>{
        postPlanRequestCount=count;
        postPlanResponseStatus=status;
        if (status!==null) stage=path+"-response";
      });
      assert(reply.ok(),"wizard_http_"+path+"_"+reply.status());
      mark(path,{status:reply.status()});
      return;
    }
    const diagnose=step==="install-original" && path==="publishing-prepare";
    if (diagnose) stage=path+"-budget";
    budget();
    const response=page.waitForResponse(reply=>{
      const url=new URL(reply.url());
      return url.origin===wizardOrigin && url.pathname==="/api/web2/"+path && reply.request().method()==="POST";
    },{timeout:Math.min(timeout,budget())});
    if (diagnose) stage=path+"-request";
    const opened=popup?page.waitForEvent("popup",{timeout:12000}):null;
    const [reply]=await Promise.all([response,button(label).click()]);
    if (opened) {
      const wallet=await opened;
      if (!wallet.isClosed()) await wallet.waitForEvent("close",{timeout:12000});
    }
    if (diagnose) {
      stage=path+"-response";
      const status=reply.status();
      if (Number.isInteger(status) && status>=100 && status<=599) publishingPrepareStatus=status;
    }
    if (held) assert.equal(reply.status(),503,"expected_fixture_approval_gate");
    else assert(reply.ok(),"wizard_http_"+path+"_"+reply.status());
    mark(path,{status:reply.status()});
  }
  async function pair() {
    mark("pair");
    await page.locator('input[type="password"][name="code"]').fill(handoff.pairingCode);
    const paired=page.waitForResponse(reply=>new URL(reply.url()).origin===wizardOrigin &&
      new URL(reply.url()).pathname==="/pair" && reply.request().method()==="POST");
    const [reply]=await Promise.all([paired,button("Connect").click()]);
    assert([200,302,303].includes(reply.status()),"pairing_refused");
    await page.getByRole("heading",{name:"Set up your HTTPS community",exact:true}).waitFor();
    handoff.pairingCode=null;
    mark("paired",{status:reply.status()});
  }
  async function untilState(name,pinned) {
    const end=Date.now()+90000;
    for (;;) {
      const saved=await journal();
      eachOriginal(saved,pinned);
      if (saved.phase===name && saved.pending===null) break;
      registrationWindow(saved);
      assert(Date.now()<end,"original_not_confirmed");
      await page.waitForTimeout(2000);
      await action("Reconcile original enrollment","reconcile",{timeout:20000});
    }
    await state(name).waitFor();
  }
  if (fresh) {
    budget(600000);
    mark("unpaired_boundary_read");
    const entry=await page.goto(handoff.wizard,{waitUntil:"domcontentloaded",timeout:15000});
    const protectedStatus=await page.evaluate(async()=>{
      const response=await fetch("/api/web2/state",{cache:"no-store",signal:AbortSignal.timeout(5000)});
      return response.status;
    });
    record.unpairedHttp={pairingPage:entry?.status(),protectedState:protectedStatus};
    assert.deepEqual(record.unpairedHttp,{pairingPage:200,protectedState:403});
    await pair();
    await page.getByLabel("Community name",{exact:true}).fill("Disposable Notes");
    await page.getByLabel("HTTPS community origin",{exact:true}).fill(handoff.communityOrigin);
    mark("fixture_wallet_connect");
    const opened=page.waitForEvent("popup");
    await button("Connect MOSS").click();
    const wallet=await opened;
    if (!wallet.isClosed()) await wallet.waitForEvent("close",{timeout:15000});
    const owner=page.getByLabel("Owner wallet",{exact:true});
    const ownerValue=await owner.inputValue();
    assert.equal(ownerValue.toLowerCase(),handoff.fixtureOwner.toLowerCase());
    await check("I reviewed the controller, owner and server publisher");
    await page.getByLabel("Pilot invitation",{exact:true}).fill(handoff.fixtureInvitation);
    await check("I accept this pilot notice and its storage limitations.");
    await action("Prepare enrollment","prepare");
    const prepared=await journal();
    assert.equal(prepared.phase,"prepared");
    assert.equal(prepared.controllerSignature,null);
    registrationWindow(prepared);
    const pinned=original(prepared);
    await action("Authorize community registration","redeem",{popup:true,held:true});
    const held=await journal();
    const retained=original(held);
    assert(retained.controllerSignatureSha256 && !held.enrollment);
    assert.deepEqual({...retained,controllerSignatureSha256:null},pinned);
    await button("Retry original registration").waitFor();
    record.original=retained;
  } else if (step==="fund-original") {
    const {original:pinned}=await checkedBefore();
    const held=await journal();
    eachOriginal(held,pinned);
    registrationWindow(held);
    await action("Retry original registration","redeem");
    await untilState("registered",pinned);
    let saved=await journal();
    registrationWindow(saved);
    assert.equal(saved.enrollment.operations.filter(op=>op.kind==="registration" && op.state==="consumed").length,1);
    await action("Authorize initial gas allocation","topup");
    await untilState("funded",pinned);
    saved=await journal();
    assert.equal(saved.enrollment.operations.length,3);
    assert(saved.enrollment.operations.every(op=>op.state==="consumed"));
    record.original=pinned;
    record.consumedOperationCount=3;
  } else if (step==="install-original") {
    const {original:pinned}=await checkedBefore(["held-receipt-path","held-receipt-file"]);
    const before=await journal(["funded-journal-path","funded-journal-file"]);
    eachOriginal(before,pinned,true);
    stage="check-funded-phase";
    assert.equal(before.phase,"funded");
    stage="review-publishing-checkbox";
    await check("I reviewed the controller, owner and server publisher for publishing");
    const armed=await boundedObserverCall((captureMs,deadline)=>{
      const now=Date.now();
      return page.evaluate(armWizardPrepareObserver,{
        origin:wizardOrigin,armBy:now+captureMs,stopAt:Math.min(deadline,now+50000),allowedCodes:[...codes],
      });
    },cutoff);
    if (armed===true) publishingObserverPage=page;
    await action("Review owner publishing","publishing-prepare");
    const review=await signing();
    assert.equal(review.accepted,null);
    assert.equal(review.authorization.ownerWallet.toLowerCase(),handoff.fixtureOwner.toLowerCase());
    assert(review.authorization.validFrom*1000<=Date.now() && Date.now()<review.authorization.expiresAt*1000);
    await check("I reviewed the owner policy, window, destination and every service limit");
    await action("Authorize owner publishing","publishing-authorize",{popup:true});
    await action("Attach reviewed publishing grant","publishing-attach");
    stage="installation-prepare-attached-indicator";
    await page.getByText("Publishing grant attached",{exact:true}).waitFor();
    stage="installation-prepare-budget";
    const rawPhaseDeadline=process.env.PIRATE_NOTES_INSTALL_PHASE_DEADLINE_MS;
    const rawMonoDeadline=process.env.PIRATE_NOTES_INSTALL_PHASE_MONO_DEADLINE_NS;
    assert.match(rawPhaseDeadline ?? "", /^\d{13}$/);
    assert.match(rawMonoDeadline ?? "", /^[1-9]\d{0,19}$/);
    const window=installationObservationWindow(Date.now(),Number(rawPhaseDeadline),Number(cutoff),
      process.hrtime.bigint(),BigInt(rawMonoDeadline));
    const installArmed=await boundedObserverCall((captureMs,deadline)=>{
      const now=Date.now();
      return page.evaluate(armWizardPrepareObserver,{
        origin:wizardOrigin,armBy:now+captureMs,stopAt:Math.min(deadline,window.stopAt),
        allowedCodes:[...codes,...installationPrepareCodes],forInstallation:true,
      });
    },cutoff);
    if (installArmed===true) installationObserverPage=page;
    stage="installation-prepare-request";
    const reply=await observeInstallationPost(page,wizardOrigin,button("Review Linux installation"),window,(client,status)=>{
      installationClient=client;
      installationPrepareStatus=status;
      if (status!==null) stage="installation-prepare-response";
    });
    assert(reply.ok(),"wizard_http_installation-prepare_"+reply.status());
    mark("installation-prepare",{status:reply.status()});
    const phaseWindow={
      stopAt:Math.min(Number(rawPhaseDeadline),Number(cutoff)-installWorkerReserveMs),
      monoStopAt:BigInt(rawMonoDeadline),
    };
    stage="install-planned-journal";
    const planned=await journal();
    stage="install-planned-original";
    eachOriginal(planned,pinned);
    stage="install-plan-draft";
    assert(planned.installPlan && !planned.installDraft.privatePractice);
    stage="install-review-checkbox";
    await check("I reviewed this installation on the selected host.");
    await action("Install reviewed community","install",{timeout:installFixtureWaitMs,phaseWindow});
    stage="install-status-decision-journal";
    if ((await journal()).phase!=="running")
      await action("Read installation status","installation-status",{timeout:30000,phaseWindow});
    stage="install-final-journal";
    const saved=await journal();
    stage="install-final-original";
    eachOriginal(saved,pinned);
    stage="install-running-observation";
    assert(saved.phase==="running" && saved.pending===null && saved.observation.state==="running");
    stage="install-running-indicator";
    await state("running").waitFor();
    stage="install-signing-read";
    const signed=await signing();
    stage="install-signing-attachment";
    assert(signed.accepted && signed.attachment && !signed.attachmentPending);
    stage="install-receipt-fields";
    record.original=pinned;
    record.installed={planId:saved.installPlan.planId,planDigest:saved.installPlan.planDigest,
      installationId:saved.installPlan.installationId,attachmentDigest:signed.attachment.digest};
  } else {
    const prior=await operation("read-prior-install-receipt",()=>privateRead(join(launch.artifacts,"w6-wizard-install-original.json")));
    await operation("pair-wizard",()=>pair());
    await operation("wait-running-indicator",()=>state("running").waitFor());
    const saved=await operation("read-retained-journal",()=>journal());
    const signed=await operation("read-signing-journal",()=>signing());
    await operation("check-retained-continuity",async()=>{
      eachOriginal(saved,prior.original);
      assert(saved.pending===null && saved.observation.state==="running" && signed.accepted && !signed.attachmentPending);
      assert.deepEqual({planId:saved.installPlan.planId,planDigest:saved.installPlan.planDigest,
        installationId:saved.installPlan.installationId,attachmentDigest:signed.attachment.digest},prior.installed);
    });
    record.original=prior.original;
    record.installed=prior.installed;
    record.additionalEnrollmentActions=0;
    writeProgress();
  }
  if (step==="install-original") stage="install-final-budget";
  budget();
  record.status="PASS";
} catch (error) {
  record.status="FAIL";
  record.failure={stage,name:error.name};
  process.exitCode=1;
  const installationFailure=installationPrepareStages.has(stage) && record.phases.length===3 &&
    record.phases[2]?.label==="publishing-attach";
  const postPlanFailure=postPlanStages.has(stage) && record.phases[3]?.label==="installation-prepare";
  if (step==="install-original" && (record.phases.length===0 || installationFailure || postPlanFailure)) {
    const classes=["AssertionError","TimeoutError","Error","SyntaxError","TypeError"];
    const errorClass=classes.includes(error.name)?error.name:"Other";
    try {
      const actionObservation=postPlanFailure && postPlanRequestStages.has(stage);
      const responseStatus=actionObservation?postPlanResponseStatus:
        postPlanFailure?null:installationFailure?installationPrepareStatus:publishingPrepareStatus;
      const refusal={stage,errorClass,responseStatus};
      if (installationFailure && installationClient) refusal.clientObservation=installationClient;
      if (actionObservation) refusal.requestCount=postPlanRequestCount;
      const captureInstallation=stage==="installation-prepare-response" && responseStatus>=400 && responseStatus<=599;
      if ((stage==="publishing-prepare-response" && responseStatus===503) || captureInstallation) {
        const page=captureInstallation?installationObserverPage:publishingObserverPage;
        const observed=page && await boundedObserverCall(
          ()=>page.evaluate(forInstallation=>forInstallation
            ? window.__pirateInstallationPrepareRefusal ?? null
            : window.__piratePublishingPrepareRefusal ?? null,captureInstallation),cutoff);
        const skips=["observer-deadline","response-mismatch","unexpected-content-type",
          "stream-unavailable","body-too-large","no-allowlisted-code"];
        const statusMatches=!captureInstallation || observed?.observedStatus===responseStatus;
        if (statusMatches && typeof observed?.responseCode==="string" && (codes.has(observed.responseCode) ||
            (captureInstallation && installationPrepareCodes.has(observed.responseCode)))) {
          refusal.responseCode=observed.responseCode;
        } else if (!statusMatches && typeof observed?.responseCode==="string") {
          refusal.captureSkip="response-mismatch";
        } else {
          refusal.captureSkip=skips.includes(observed?.captureSkip)?observed.captureSkip:"observer-unavailable";
        }
      }
      await writeFile(join(root,"notes-wizard-install-refusal.json"),JSON.stringify(refusal)+"\n",
        {flag:"wx",mode:0o600,flush:true});
    } catch { /* Preserve the browser failure and its existing private receipt. */ }
  }
} finally {
  await operation("browser-close",()=>browser.close());
  writeProgress();
  await writeFile(join(artifactDir,"w6-wizard-"+step+".json"),JSON.stringify({...record,endedUtc:now()},null,2)+"\n",
    {flag:"wx",mode:0o600});
}
