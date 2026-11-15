import assert from "node:assert/strict";
import {hostname,platform,arch} from "node:os";
import {readFile,lstat,realpath,readdir,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {runOwnedCommand,runCurrentAuthorityCommand} from "./backend-command.ts";
import {privateFile,privateDirectory,hash,createJSON,processIdentity,sameProcess,type OperationLease} from "./backend-state.ts";
import {assertStartAllowed,createMaintenanceGuard} from "./maintenance-guard.ts";
import {containerProcessEvidence,requireObserverHostFrame,requireLifetimeAbsent} from "./writer-evidence.ts";
import {readPrivateJSON,canonicalDigest,evidenceId} from "./installed-records.ts";

export interface InstalledContainer {
  key:string;name:string;imageId:string;configurationDigest:string;ingress:boolean;
  user:string;argv:string[];roles:string[];network:string;
  mounts:Array<{source:string;target:string;readOnly:boolean}>;
  ports:Array<{ip:string;host:number;container:number}>;
}
export interface InstalledTarget {
  installationId:string;daemonId:string;docker:string;dockerSha256:string;socket:string;dockerConfig:string;
  stateRoot:string;maintenanceDirectory:string;resourceDirectory:string;outputDirectory:string;cwd:string;
  environment:NodeJS.ProcessEnv;containers:InstalledContainer[];hostWriters:ReadonlyArray<NonNullable<Awaited<ReturnType<typeof processIdentity>>>>;
  allowedReadOnlyRoots:string[];allowedWritableRoots:string[];
}
export async function createLocalController(config:InstalledTarget,lease:OperationLease) {
  assert(config.installationId===lease.installationId && config.containers.length>0);
  await privateDirectory(config.stateRoot);await privateDirectory(config.resourceDirectory);await privateDirectory(config.outputDirectory);
  await privateDirectory(config.dockerConfig);assert.deepEqual(await readdir(config.dockerConfig),[]);
  assert.equal(await realpath(config.socket),config.socket);
  const socket=await lstat(config.socket);assert(socket.isSocket(),"local_docker_socket_required");
  assert(config.environment.HOME && !("DOCKER_HOST" in config.environment) && !("DOCKER_CONTEXT" in config.environment));
  let sequence=0,closed=false;
  async function command(args:string[],signal:AbortSignal,seconds=45,assertCurrent?:()=>Promise<void>) {
    const readOnly=args[0]==="info" || args[0]==="inspect" ||
      args[0]==="network" && args[1]==="inspect" || args[0]==="container" && args[1]==="ls";
    const mutation=args[0]==="container" && ["create","start","stop"].includes(args[1]!);
    assert(readOnly || mutation && typeof assertCurrent==="function","actual_current_effect_authority_required");
    assert(!closed && !signal.aborted);await lease.assertHeld();
    requireObserverHostFrame(lease.holder,await processIdentity(process.pid));
    const current=await lstat(config.socket);assert(current.dev===socket.dev && current.ino===socket.ino && current.isSocket(),"daemon_socket_changed");
    const input={lease,executable:config.docker,executableSha256:config.dockerSha256,
      argv:["--host","unix://"+config.socket,"--config",config.dockerConfig,...args],
      outputDirectory:config.outputDirectory,cwd:config.cwd,environment:config.environment,
      signal,name:"target-"+String(++sequence).padStart(6,"0"),seconds};
    const result=mutation?await runCurrentAuthorityCommand(input,assertCurrent!):await runOwnedCommand(input);
    const file=await privateFile(result.stdoutPath,16*1024**2);
    try{return {text:await file.readFile("utf8"),facts:result.facts};}finally{await file.close();}
  }
  async function daemon(signal:AbortSignal) {
    const value=JSON.parse((await command(["info","--format","{{json .}}"],signal)).text);
    assert(value.ID===config.daemonId && value.Name===hostname(),"actual_daemon_changed");return value;
  }
  async function all(signal:AbortSignal):Promise<any[]> {
    await daemon(signal);
    const ids=(await command(["container","ls","--all","--quiet","--no-trunc"],signal)).text.trim().split(/\s+/).filter(Boolean);
    assert(ids.length<=10000 && ids.every(x=>/^[a-f0-9]{64}$/.test(x)));
    if(!ids.length)return [];
    const rows=JSON.parse((await command(["inspect","--type","container",...ids],signal)).text);
    assert(Array.isArray(rows) && rows.length===ids.length && new Set(rows.map(x=>x.Id)).size===ids.length);return rows;
  }
  const overlaps=(a:string,b:string)=>a===b || a.startsWith(b+"/") || b.startsWith(a+"/");
  async function owned(spec:InstalledContainer,rows:any[]) {
    const found=rows.filter(x=>x.Name==="/"+spec.name);assert(found.length<=1,"ambiguous_container_name");
    if(!found.length)return null;
    const row=found[0];
    assert(row.Config.Labels["io.pirate.installation"]===config.installationId &&
      row.Config.Labels["io.pirate.resource"]===spec.key && row.Image===spec.imageId &&
      canonicalDigest(row.Config)===spec.configurationDigest,"container_identity_or_config_conflict");
    assert(row.HostConfig.Privileged===false && row.HostConfig.ReadonlyRootfs===true && row.HostConfig.PidMode!=="host" &&
      row.HostConfig.RestartPolicy.Name==="no" && row.HostConfig.CapDrop.includes("ALL"),"container_privilege_or_restart_policy_changed");
    assert.deepEqual(row.Mounts.map((m:any)=>({source:m.Source,target:m.Destination,readOnly:!m.RW})).sort((a:any,b:any)=>a.target<b.target?-1:1),
      [...spec.mounts].sort((a,b)=>a.target<b.target?-1:1),"container_state_mounts_changed");
    const recorded=await readPrivateJSON<{id:string;key:string}>(join(config.resourceDirectory,evidenceId(spec.key)+".json"));
    assert(recorded.id===row.Id && recorded.key===spec.key,"original_resource_binding_changed");return row;
  }
  async function inspect(signal:AbortSignal) {
    const rows=await all(signal),roots=config.containers.flatMap(x=>x.mounts.filter(m=>!m.readOnly).map(m=>m.source));
    for(const row of rows) {
      const touches=row.Mounts.some((m:any)=>m.RW && roots.some(r=>overlaps(m.Source,r)));
      assert(!touches || config.containers.some(x=>row.Name==="/"+x.name),"unregistered_state_writer");
    }
    const resources=[];
    for(const spec of config.containers) resources.push({spec,actual:await owned(spec,rows)});
    const machine=(await readFile("/etc/machine-id","utf8")).trim();assert(/^[a-f0-9]{32}$/.test(machine));
    const fingerprint=canonicalDigest({machineId:machine,daemonId:config.daemonId,installationId:config.installationId,stateRoot:config.stateRoot});
    return {fingerprint,resources,platform:platform(),architecture:arch()};
  }
  return {
    config,command,inspect,
    async inspectHost(signal:AbortSignal) {
      const result=await inspect(signal),os=await readFile("/etc/os-release","utf8");
      const supported=result.platform==="linux" && result.architecture==="x64" && /^ID=ubuntu$/m.test(os) && /^VERSION_ID="24.04"$/m.test(os);
      return {...result,supported,corrections:supported?[]:["The complete target is qualified against Ubuntu24.04 amd64 only after actual acceptance."]};
    },
    async create(signal:AbortSignal,assertCurrent:()=>Promise<void>) {
      assert(typeof assertCurrent==="function","actual_current_effect_authority_required");
      await assertCurrent();assert(!signal.aborted,"native_effect_cancelled");
      await assertStartAllowed(config.maintenanceDirectory);
      const before=await inspect(signal);assert(before.resources.every(x=>x.actual===null),"fresh_create_refuses_adoption");
      for(const spec of config.containers) {
        await lease.assertHeld();await assertStartAllowed(config.maintenanceDirectory);
        assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(spec.name) && /^sha256:[a-f0-9]{64}$/.test(spec.imageId));
        assert(/^[0-9]+:[0-9]+$/.test(spec.user) && spec.user.split(":").every(x=>Number(x)>0) && spec.argv.length>0 && spec.roles.length>0);
        assert(/^[a-f0-9]{64}$/.test(spec.network),"explicit_private_bridge_network_id_required");
        const network=JSON.parse((await command(["network","inspect",spec.network],signal)).text)[0];
        assert(network.Id===spec.network && network.Driver==="bridge" && network.Scope==="local","actual_local_bridge_required");
        for(const mount of spec.mounts){assert(mount.source.startsWith("/") && !mount.source.includes(",") && mount.target.startsWith("/") && !mount.target.includes(","));
          assert(!["/proc","/sys","/dev"].some(x=>mount.target===x || mount.target.startsWith(x+"/")),"protected_system_mount_refused");
          const allowed=mount.readOnly?config.allowedReadOnlyRoots:config.allowedWritableRoots;
          assert(allowed.some(x=>mount.source===x || mount.source.startsWith(x+"/")),"unapproved_mount_root");
          assert.equal(await realpath(mount.source),mount.source);
        }
        const args=["container","create","--pull=never","--name",spec.name,"--hostname",spec.name,"--read-only","--cap-drop=ALL",
          "--security-opt=no-new-privileges","--restart=no","--user",spec.user,"--network",spec.network,
          "--label","io.pirate.installation="+config.installationId,"--label","io.pirate.resource="+spec.key];
        for(const m of spec.mounts)args.push("--mount","type=bind,src="+m.source+",dst="+m.target+(m.readOnly?",readonly":""));
        for(const p of spec.ports){assert(/^[0-9.]+$/.test(p.ip) && p.host>0 && p.host<=65535 && p.container>0 && p.container<=65535);args.push("--publish",p.ip+":"+p.host+":"+p.container);}
        args.push("--entrypoint",spec.argv[0]!,spec.imageId,...spec.argv.slice(1));
        await lease.record("container-create-intent",{resourceKey:spec.key,name:spec.name,configurationDigest:spec.configurationDigest});
        // Any lost reply retains intent and named resource; never silently rerun.
        const result=await command(args,signal,90,assertCurrent),id=result.text.trim();assert(/^[a-f0-9]{64}$/.test(id));
        const actual=JSON.parse((await command(["inspect","--type","container",id],signal)).text)[0];
        assert(actual.Id===id && actual.Image===spec.imageId && canonicalDigest(actual.Config)===spec.configurationDigest,"created_container_mismatch");
        await createJSON(config.resourceDirectory,evidenceId(spec.key),{id,key:spec.key,name:spec.name,
          installationId:config.installationId,configurationDigest:spec.configurationDigest,operationId:lease.operationId});
      }
      return inspect(signal);
    },
    async start(signal:AbortSignal,assertCurrent:()=>Promise<void>) {
      assert(typeof assertCurrent==="function","actual_current_effect_authority_required");
      await assertCurrent();assert(!signal.aborted,"native_effect_cancelled");
      const snapshot=await inspect(signal);
      for(const row of [...snapshot.resources].sort((a,b)=>Number(a.spec.ingress)-Number(b.spec.ingress))) {
        assert(row.actual,"missing_original_resource");await assertStartAllowed(config.maintenanceDirectory);
        assert(!row.actual.State.Paused && !row.actual.State.Restarting && !row.actual.State.Dead);
        if(!row.actual.State.Running)await command(["container","start",row.actual.Id],signal,45,assertCurrent);
      }
      const after=await inspect(signal);assert(after.resources.every(x=>x.actual?.State.Running),"required_service_not_running");
      return after;
    },
    async stop(signal:AbortSignal,assertCurrent:()=>Promise<void>) {
      assert(typeof assertCurrent==="function","actual_current_effect_authority_required");
      await assertCurrent();assert(!signal.aborted,"native_effect_cancelled");
      const maintenance=await createMaintenanceGuard(config.maintenanceDirectory,lease);await maintenance.enterMaintenance();
      const before=await inspect(signal),processes=[];
      for(const row of [...before.resources].sort((a,b)=>Number(b.spec.ingress)-Number(a.spec.ingress))) {
        assert(row.actual,"missing_original_resource");
        if(row.actual.State.Running) {
          const observer=requireObserverHostFrame(lease.holder,await processIdentity(process.pid));
          const evidence=containerProcessEvidence(observer,row.actual.Id,row.actual.State.Pid,await processIdentity(row.actual.State.Pid));
          processes.push(evidence.containerProcess);await lease.record("controller-writer-observed",evidence);
          await command(["container","stop","--time","30",row.actual.Id],signal,45,assertCurrent);
        }
      }
      const scans=[];
      for(let n=0;n<2;n++){
        await maintenance.assertMaintenanceHeld();const state=await inspect(signal);
        assert(state.resources.every(x=>x.actual && !x.actual.State.Running && x.actual.State.Pid===0 && x.actual.State.ExitCode===0),"writers_not_cleanly_stopped");
        scans.push({resources:state.resources.map(x=>({key:x.spec.key,id:x.actual.Id,state:x.actual.State})),
          lifetimes:await Promise.all([...processes,...config.hostWriters].map(async p=>requireLifetimeAbsent(p,await processIdentity(p.hostPid))))});
      }
      const receipt=await lease.record("whole-installed-writer-barrier",{scans,installationId:config.installationId});
      return {receipt,scans,maintenance};
    },
    async dispose(){closed=true;} // No resource deletion, signal, lease/fence release.
  };
}

