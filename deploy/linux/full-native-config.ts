import assert from "node:assert/strict";
import { parseSharedSongFeed, sharedSongFeedBinding } from "../../services/shared-song-feed-settings.ts";
export interface NativeBinding {name:string;service?:string;text?:string;file?:string;durable?:{service:string;className:string}}
export interface NativeGraph {
  installationId:string;durableScope:string;releaseRoot:string;schemaPath:string;stateRoots:Record<string,string>;socket:string;
  applicationBindings:NativeBinding[];
  actors:Array<{service:string;module:string;role:string;namespaces:Array<{className:string;key:string}>;
    bindings:NativeBinding[]}>;
  requiredRoles:string[];queueConfiguration:unknown;maintenanceConfiguration:unknown;
  directoryRuntimeBinding:string;allowedOrigins:string[];
  localActivitySocket?:string;
  secretBindings:Array<{name:string;path:string}>;
  listenAddress:string;tls:{keyFile:string;certificateFile:string};
  migrationPlanFile:string;
  coldPlanFile?:string;
  probePlanFile:string;readbackKeyFile:string;
  /** Disposable local qualification only; absent on the public-provider path. */
  fixtureTransport?:{schema:"pirate.linux-local-fixture-transport/1";peer:string;routes:Array<{origin:string;upstream:string}>};
}
const q=JSON.stringify;
const publicText=(v:NativeBinding)=> !/KEY|SECRET|TOKEN|PASSWORD/.test(v.name) ||
  ((v.name==="PAYMENT_TOKEN" || v.name==="KARAOKE_PAYMENT_TOKEN") &&
    typeof v.text==="string" && /^0x[a-f0-9]{40}$/.test(v.text));
const binding=(v:NativeBinding)=>{
  assert(/^[A-Z][A-Z0-9_]*$/.test(v.name) && [v.service,v.text,v.file,v.durable].filter(x=>x!==undefined).length===1,"native_binding_invalid");
  if(v.service!==undefined)return `(name=${q(v.name)},service=${q(v.service)})`;
  if(v.file!==undefined){assert(v.file.startsWith("/"));return `(name=${q(v.name)},text=embed ${q(v.file)})`;}
  if(v.durable!==undefined)return `(name=${q(v.name)},durableObjectNamespace=(serviceName=${q(v.durable.service)},className=${q(v.durable.className)}))`;
  assert(publicText(v),"public_release_contains_secret_binding");return `(name=${q(v.name)},text=${q(v.text)})`;
};
/** Actual native services, not the diagnostic ledger. Unknown selected actors
 * or final Directory binding refuse; the caller supplies exact accepted bytes. */
export function renderFullNativeConfig(g:NativeGraph,mode:"serve"|"initialize"|"cold-reconcile"="serve",bootId?:string,nativeOriginalFile?:string,runtimeSocket=g.socket) {
  const initialize=mode!=="serve";
  assert(runtimeSocket===g.socket || runtimeSocket.startsWith("/run/") && !runtimeSocket.split("/").includes(".."),"private_per_boot_control_socket_required");
  assert(initialize || (typeof bootId==="string" && /^[a-f0-9]{64}$/.test(bootId)),"fresh_actual_process_boot_identity_required");
  assert(g.installationId.length>0 && !/[\x00-\x1f\x7f]/.test(g.installationId) && /^[a-f0-9]{64}$/.test(g.durableScope) && g.releaseRoot.startsWith("/") && g.socket.startsWith("/"));
  assert(g.directoryRuntimeBinding.length>0,"accepted_directory_runtime_binding_required");
  assert(g.listenAddress.length>0 && g.tls.keyFile.startsWith("/") && g.tls.certificateFile.startsWith("/"));
  assert(g.applicationBindings.every(publicText),"public_release_contains_secret_binding");
  assert(g.secretBindings.every(x=>/^[A-Z][A-Z0-9_]*$/.test(x.name) && x.path.startsWith("/")));
  const sharedFeeds = g.applicationBindings.filter(input => input.name === sharedSongFeedBinding);
  assert(sharedFeeds.length <= 1 && !g.secretBindings.some(input => input.name === sharedSongFeedBinding),
    "shared_song_feed_binding_changed");
  const sharedFeed = sharedFeeds[0];
  if (sharedFeed) {
    assert(sharedFeed.text !== undefined && !sharedFeed.service && !sharedFeed.file && !sharedFeed.durable,
      "shared_song_feed_profile_text_required");
    const { origins } = parseSharedSongFeed(sharedFeed.text);
    assert([...origins].every(origin => g.allowedOrigins.includes(origin) &&
      (!g.fixtureTransport || g.fixtureTransport.routes.some(route => route.origin === origin))),
      "shared_song_feed_origin_egress_missing");
  }
  const scope=g.durableScope,roles=new Set(["application","database","objects","jobs","scheduler","assets",...g.actors.map(x=>x.role)]);
  assert((g.queueConfiguration as {scope?:string}).scope===scope && (g.maintenanceConfiguration as {scope?:string}).scope===scope,"original_durable_scope_binding_required");
  assert(g.requiredRoles.every(x=>roles.has(x)),"selected_service_graph_incomplete");
  for(const key of ["database","objects","jobs","scheduler"])assert(g.stateRoots[key]?.startsWith("/"),"native_durable_root_required");
  const module=(file:string)=>{assert(/^[A-Za-z0-9_.-]+$/.test(file));return g.releaseRoot+"/"+file;};
  const disk=(name:string,path:string)=>`(name=${q(name)},disk=(path=${q(path)},writable=true,allowDotfiles=true))`;
  const worker=(name:string,file:string,bindings:string,namespaces="",storage?:string|null,outbound="deny",experimental=false)=>
    `(name=${q(name)},worker=(modules=[(name="entry.mjs",esModule=embed ${q(module(file))})],compatibilityDate="2026-11-04",
       compatibilityFlags=${JSON.stringify(["nodejs_compat","service_binding_extra_handlers",...(experimental?["experimental"]:[])])},bindings=[${bindings}],
       ${namespaces?"durableObjectNamespaces=["+namespaces+"],":""}${storage===null?"durableObjectStorage=(inMemory=void),":storage?"durableObjectStorage=(localDisk="+q(storage)+"),":""}globalOutbound=${q(outbound)}))`;
  const ns=(service:string,cls:string,key:string)=>`(className=${q(cls)},uniqueKey=${q(key)},enableSql=true)`;
  const doBinding=(name:string,service:string,cls:string)=>`(name=${q(name)},durableObjectNamespace=(serviceName=${q(service)},className=${q(cls)}))`;
  const objectEntry=(name:string,service:string,cls:string,namespace:string)=>worker(name,"object-entry.worker.js",
    `(name="MINIFLARE_NAMESPACE",text=${q(namespace)}),${doBinding("MINIFLARE_OBJECT",service,cls)}`);
  const fixture=g.fixtureTransport;
  if(fixture){
    assert(fixture.schema==="pirate.linux-local-fixture-transport/1" && fixture.routes.length>0 && fixture.routes.length<=16);
    const numbers=fixture.peer.split(".").map(Number);
    assert(numbers.length===4 && numbers.every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
      numbers.join(".")===fixture.peer && (numbers[0]===10 || numbers[0]===172 && numbers[1]!>=16 && numbers[1]!<=31 ||
      numbers[0]===192 && numbers[1]===168),"explicit_private_fixture_peer_required");
    assert(new Set(fixture.routes.map(x=>x.origin)).size===fixture.routes.length);
    for(const route of fixture.routes){
      const origin=new URL(route.origin),target=new URL(route.upstream);
      assert(["https:","http:"].includes(origin.protocol) && origin.origin===route.origin && g.allowedOrigins.includes(route.origin) &&
        (origin.hostname==="127.0.0.1" || origin.hostname==="localhost" || origin.hostname.endsWith(".example") || origin.hostname.endsWith(".test")),
        "fixture_cannot_replace_public_provider");
      assert(target.protocol==="http:" && target.hostname===fixture.peer && target.port && !target.username && !target.password &&
        !target.search && !target.hash && /^\/fixture\/[a-z0-9-]+$/.test(target.pathname),"exact_owned_fixture_route_required");
    }
  }
  const services=[
    objectEntry("d1-entry","d1-backend","D1DatabaseObject","database-"+scope),
    worker("d1-backend","database.worker.js","",ns("d1-backend","D1DatabaseObject","database-v1-"+scope),"database-storage","deny",true),
    objectEntry("media-entry","media-backend","R2BucketObject","objects-"+scope),
    worker("media-backend","bucket.worker.js",`(name="MINIFLARE_BLOBS",service="object-storage")`,
      ns("media-backend","R2BucketObject","objects-v1-"+scope),"object-storage","deny",true),
    worker("queue","queue.mjs",doBinding("QUEUE_STATE","queue","PersistentQueue")+
      ',(name="CONSUMER",service="application"),(name="QUEUE_CONFIGURATION",text='+q(JSON.stringify(g.queueConfiguration))+')',
      ns("queue","PersistentQueue","queue-v1-"+scope),"queue-storage"),
    worker("scheduler","maintenance.mjs",doBinding("MAINTENANCE_STATE","scheduler","PersistentMaintenance")+
      ',(name="CONSUMER",service="application"),(name="MAINTENANCE_CONFIGURATION",text='+q(JSON.stringify(g.maintenanceConfiguration))+')',
      ns("scheduler","PersistentMaintenance","maintenance-v1-"+scope),"scheduler-storage"),
    disk("database-storage",g.stateRoots.database!),disk("object-storage",g.stateRoots.objects!),
    disk("queue-storage",g.stateRoots.jobs!),disk("scheduler-storage",g.stateRoots.scheduler!),
    '(name="asset-files",disk=(path='+q(g.releaseRoot+"/assets")+',writable=false))',
    worker("assets","assets.worker.mjs",'(name="FILES",service="asset-files"),(name="ASSET_INDEX_JSON",text=embed '+q(g.releaseRoot+"/asset-index.json")+')'),
    worker("egress",fixture?"web2-fixture-egress.worker.mjs":"egress-policy.worker.mjs",
      fixture?'(name="FIXTURE_ROUTES_JSON",text='+q(JSON.stringify(fixture.routes))+')':
        '(name="ALLOWED_ORIGINS",text='+q(JSON.stringify(g.allowedOrigins))+')',"",undefined,fixture?"fixture-peer":"internet"),
    ...(fixture?['(name="fixture-peer",network=(allow=['+q(fixture.peer+"/32")+']))']:[]),
    '(name="internet",network=(allow=["public"]))',
    worker("deny","deny.worker.mjs",""),
  ];
  if (g.localActivitySocket !== undefined) {
    assert(/^\/[a-zA-Z0-9_./-]{1,100}\.sock$/.test(g.localActivitySocket) &&
      !g.localActivitySocket.split("/").some(part => part === "." || part === ".."), "private_activity_socket_required");
    services.push('(name="web2-local-activities",external=(address='+q("unix:"+g.localActivitySocket)+',http=()))');
  }
  const karaokeLease = g.applicationBindings.find(b => b.name === "KARAOKE_NATIVE_SESSION_CAPTURE");
  if (karaokeLease) {
    const operator = g.actors.find(a=>a.service==="private-karaoke-operator");
    const gate="private-karaoke-session", cls="NativeKaraokeSessions";
    assert(operator?.module==="web2-private-karaoke.worker.mjs" &&
      operator.bindings.some(b=>b.name==="KARAOKE_LOCAL_SESSION_GATE" && b.service===gate) &&
      karaokeLease.durable?.service===gate && karaokeLease.durable.className===cls &&
      !g.actors.some(a=>a.service===gate),"native_karaoke_lease_graph_changed");
    const original=JSON.parse(g.directoryRuntimeBinding) as {directoryProfile:{communityId:string};origin:string};
    const leaseScope=JSON.stringify({communityId:original.directoryProfile.communityId,origin:original.origin});
    services.push(worker(gate,operator.module,
      '(name="DB",wrapped=(moduleName="cloudflare-internal:d1-api",innerBindings=[(name="fetcher",service="d1-entry")])), '+
      doBinding("KARAOKE_NATIVE_SESSION_CAPTURE",gate,cls)+',(name="KARAOKE_NATIVE_SESSION_SCOPE",text='+q(leaseScope)+')',
      '(className='+q(cls)+',uniqueKey='+q("karaoke-browser-lease-v1-"+scope)+',preventEviction=true)',null,"deny"));
  }
  for(const actor of g.actors){
    assert(/^[a-z][a-z0-9-]*$/.test(actor.service));
    const store="actor-"+actor.service;assert(g.stateRoots[actor.role]?.startsWith("/"));
    services.push(disk(store,g.stateRoots[actor.role]!));
    services.push(worker(actor.service,actor.module,actor.bindings.map(binding).join(","),
      actor.namespaces.map(x=>ns(actor.service,x.className,x.key)).join(","),store,"egress"));
  }
  assert(!g.applicationBindings.some(x=>["DB","MEDIA","JOBS","ASSETS","COMMUNITY_DEPLOYMENT_PROFILE_JSON",
    "NATIVE_APPLICATION_ORIGINAL_JSON","NATIVE_READBACK_KEY"].includes(x.name)));
  assert(!g.secretBindings.some(x=>["NATIVE_APPLICATION_ORIGINAL_JSON","NATIVE_READBACK_KEY"].includes(x.name)),"reserved_native_authority_binding");
  if(nativeOriginalFile)assert(nativeOriginalFile.startsWith("/"));
  services.push(worker("application","application.mjs",
    '(name="DB",wrapped=(moduleName="cloudflare-internal:d1-api",innerBindings=[(name="fetcher",service="d1-entry")])),'
    +'(name="MEDIA",r2Bucket="media-entry"),(name="JOBS",queue=(name="queue")),(name="ASSETS",service="assets"),'
    +'(name="COMMUNITY_DEPLOYMENT_PROFILE_JSON",text='+q(g.directoryRuntimeBinding)+'),'
    +(nativeOriginalFile?'(name="NATIVE_APPLICATION_ORIGINAL_JSON",text=embed '+q(nativeOriginalFile)+'),'
      +'(name="NATIVE_READBACK_KEY",text=embed '+q(g.readbackKeyFile)+'),':'')
    +[...g.applicationBindings.map(binding),...g.secretBindings.map(x=>'(name='+q(x.name)+',text=embed '+q(x.path)+')')].join(","),"",undefined,"egress"));
  assert(g.stateRoots.readiness?.startsWith("/"),"persistent_handler_readback_root_required");
  services.push(disk("readback-storage",g.stateRoots.readiness!));
  services.push(worker("readiness","selected-handler-observer.worker.mjs",
    '(name="APPLICATION",service="application"),'+doBinding("AUDIT","readiness","HandlerReadbackAudit")
    +',(name="PROBE_PLAN_JSON",text=embed '+q(g.probePlanFile)+')',
    ns("readiness","HandlerReadbackAudit","readback-v1-"+scope),"readback-storage"));
  services.push(worker("startup","full-startup.worker.mjs",
    '(name="QUEUE",service="queue"),(name="SCHEDULER",service="scheduler"),(name="BOOT_ID",text='+q(bootId??"")+'),'
    +doBinding("BOOT_STATE","startup","BootAdmission"),ns("startup","BootAdmission","boot-admission-v1-"+scope),"readback-storage"));
  services.push(worker("gateway","full-gateway.worker.mjs",'(name="APPLICATION",service="application"),(name="STARTUP",service="startup"),(name="OBSERVER",service="readiness"),'
    +'(name="READBACK_KEY",text=embed '+q(g.readbackKeyFile)+')'));
  if(initialize)services.push(worker("initialize","maintenance.bootstrap.mjs",
    '(name="DB",wrapped=(moduleName="cloudflare-internal:d1-api",innerBindings=[(name="fetcher",service="d1-entry")])),(name="MEDIA",r2Bucket="media-entry"),'
    +'(name="MIGRATION_PLAN_JSON",text=embed '+q(g.migrationPlanFile)+')'
    +(nativeOriginalFile?',(name="NATIVE_APPLICATION_ORIGINAL_JSON",text=embed '+q(nativeOriginalFile)+')':'')));
  if(mode==="cold-reconcile") {
    assert(typeof g.coldPlanFile==="string" && g.coldPlanFile.startsWith("/"),"explicit_cold_reconciliation_plan_required");
    assert(g.stateRoots.reconciliation?.startsWith("/"),"reconciliation_durable_root_required");
    services.push(disk("reconciliation-storage",g.stateRoots.reconciliation!));
    services.push(worker("cold-reconcile","cold-reconcile.worker.mjs",
      '(name="DB",wrapped=(moduleName="cloudflare-internal:d1-api",innerBindings=[(name="fetcher",service="d1-entry")])),(name="COLD_PLAN_JSON",text=embed '+q(g.coldPlanFile)+'),'
      +doBinding("AUDIT","cold-reconcile","RestoreAudit"),ns("cold-reconcile","RestoreAudit","restore-audit-v1-"+scope),"reconciliation-storage"));
  }
  const coldOnly=["d1-entry","d1-backend","media-entry","media-backend","database-storage","object-storage","deny","initialize","cold-reconcile","reconciliation-storage"];
  const selectedServices=mode==="serve"?services:services.filter(s=>coldOnly.some(name=>s.startsWith('(name='+q(name)+',')));
  // No queue/scheduler/selected application namespaces are registered during
  // cold reconciliation: restored alarms cannot run before domain admission.
  assert(g.schemaPath===g.releaseRoot+"/workerd.capnp","exact_installed_workerd_schema_required");
  return 'using Workerd=import '+q(g.schemaPath)+';\nconst config :Workerd.Config=(extensions=[(modules=['
    +'(name="miniflare:shared",esModule=embed '+q(module("shared.worker.js"))+'),'
    +'(name="miniflare:zod",esModule=embed '+q(module("zod.worker.js"))+')])],services=['+selectedServices.join(",\n")
    +'],sockets=['+(initialize?'(name="initialize",address='+q("unix:"+runtimeSocket)+',http=(),service='+q(mode==="cold-reconcile"?"cold-reconcile":"initialize")+')':
      '(name="application",address='+q(g.listenAddress)+',https=(options=(),tlsOptions=(keypair=(privateKey=embed '+q(g.tls.keyFile)+',certificateChain=embed '+q(g.tls.certificateFile)+'))),service="gateway"),(name="private-startup",address='+q('unix:'+runtimeSocket)+',http=(),service="startup")')+']);\n';
}

