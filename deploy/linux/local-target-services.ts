import {retainedReview} from "./retained-review.ts";
import {sameOperationalSelection} from "../../packages/community-setup/operational-selection.ts";
import assert from "node:assert/strict";
import {createCurrentMutationAuthority} from "./current-mutation-authority.ts";
import {createApplicationReadbackAuthority} from "./application-readback-authority.ts";
import {createSharedRuntimeReader} from "./shared-runtime-readback.ts";
import {SharedResultProducer} from "./shared-v2-result-producer.ts";
import {boundedIntent} from "./shared-v2-output-bounds.ts";
import {mkdir,readdir,lstat} from "node:fs/promises";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {realpath} from "node:fs/promises";
import {createSharedLinuxDeploymentPort,type LinuxSharedBackendServices} from "./wizard-backend.ts";
import {acquireOperation,createJSON,hash,privateDirectory,syncDirectory,type OperationLease} from "./backend-state.ts";
import {canonicalDigest,readPrivateJSON,immutableRecord,verifyRecord,evidenceId,assertIndependentTrustAnchors,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {createLocalController,type InstalledTarget} from "./local-target-controller.ts";
import {verifyInstalledRelease,type FullRelease} from "./installed-release.ts";
import {createManagedKeyClient} from "./managed-key-channel.ts";
import {createManagedCredentials,type CredentialSelection} from "./managed-credentials.ts";
import {createManagedRecoveryKeys} from "./managed-recovery-keys.ts";
import {createProfileAuthority,type ProfileAdmission,type CurrentAdmission} from "./full-profile-authority.ts";
import {produceOriginalProfile,readProfileTemplate} from "./profile-producer.ts";
import {createFullBackupService} from "./full-backup-service.ts";
import {runActualReadbacks,type ReadbackSpec} from "./actual-service-readback.ts";
import {readWholeClearance,type WholeClearance} from "./independent-clearance.ts";
import {runCurrentAuthorityCommand} from "./backend-command.ts";
import {releaseRestoredFences} from "./restored-fence-release.ts";
import {materializeRuntimeSecrets} from "./runtime-secret-files.ts";
import {releaseOwnedMaintenance} from "./maintenance-release.ts";
import {copyControlCohort} from "./control-cohort-copy.ts";
import {exportEncryptedBackup} from "./backup-transport.ts";
import {writeColdPlan} from "./cold-plan.ts";
import {MAX_CIPHERTEXT_BYTES} from "./backup-staging.ts";
import {actualLogin,type LoginScope} from "./actual-login-probe.ts";
import {configuredPublisherVerified} from "./publisher-profile-verification.ts";
import {boundIntentFrom,reconciliationFrom} from "../../apps/community-wizard/server/linux-operator-boundary.ts";
import {planFrom} from "../../apps/community-wizard/server/linux-boundaries.ts";
import type {LinuxCapabilities,LinuxOperation,LinuxPlan,LinuxObservation,BoundLinuxIntent,LinuxOperationResult,
 NamespaceAuthorityPort,NamespaceProof,LinuxReconciliationRequest} from "../../apps/community-wizard/server/linux-contracts.ts";
export interface LocalTargetInputs {
  installationId:string;adapterId:string;trust:TrustAnchor;custodyTrust:TrustAnchor;
  // Explicit shared-V2 native source path and original-result policy.
  // Old V1 profiles/journals are retained or explicitly refused, never relabelled.
  sourceRoot:string;resultsDirectory:string;
  bootstrapLease:OperationLease;keyChannel:{socket:string;authenticationKey:Uint8Array};
  currentAdmissionFile:string;publisherAdmissionFile:string;profileTemplateFile:string;minimumGeneration:number;hostFingerprint:string;
  installationScopeBindingFile:string;
  directoryBindingFile:string;directoryTrust:TrustAnchor;
  resourceBindings:Record<string,{kind:"container";containerKey:string}|{kind:"native-state";role:string;namespaceKey:string}>;
  releaseRecord:SignedRecord<FullRelease>;namespace:NamespaceAuthorityPort;namespaceProofFile:string;
  target:InstalledTarget;catalog:LinuxCapabilities;credentials:CredentialSelection[];
  credentialsDirectory:string;recoveryKeysDirectory:string;recoveryKeyStoreId:string;vaultKeyRef:string;vaultKeyGeneration:number;
  snapshotRoots:Record<string,string>;stagingDirectory:string;plaintextStagingDirectory:string;inspectionDirectory:string;
  plansDirectory:string;profileRecordsDirectory:string;operationsDirectory:string;observationDirectory:string;
  clearanceDirectory:string;readbacks:ReadbackSpec[];
  freshRestoreTarget:string;localStagingCredentialRef:{storeId:string;keyId:string;generation:number};
  initializer:{script:string;scriptSha256:string;executable:string;sha256:string;template:Record<string,unknown>};
  coldQueries:Array<{id:string;sql:string;sha256:string;owningSourceSHA256:string}>;
  loginProbeKeyRef:{keyId:string;generation:number};loginScope:LoginScope;
  readbackKeyRef:{keyId:string;generation:number};
  runtimeSecretsDirectory:string;runtimeSecrets:Array<{name:string;credentialId?:string;keyRef?:string;generation:number;encoding:"utf8"|"hex";prefix:string}>;
}
interface OperationContext {
  operation:LinuxOperation;bound:BoundLinuxIntent;lease:OperationLease;controller:Awaited<ReturnType<typeof createLocalController>>;
  result?:LinuxOperationResult;readback?:Awaited<ReturnType<typeof runActualReadbacks>>;postguard?:{relativePath:string;sha256:string};
  runtimeSecrets?:Awaited<ReturnType<typeof materializeRuntimeSecrets>>;
  sharedConfiguration?:Awaited<ReturnType<Awaited<ReturnType<typeof createSharedRuntimeReader>>["read"]>>;
  failure?:unknown;revision?:number;clearanceRequest?:Parameters<typeof readWholeClearance>[0];
}
export async function createLocalTargetImplementation(c:LocalTargetInputs) {
  c={...c,trust:Object.freeze({...c.trust}),custodyTrust:Object.freeze({...c.custodyTrust})};
  {
    const freeze=<T>(v:T):T=>{if(v && typeof v==="object"){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
    c={...c,target:freeze(structuredClone(c.target)),credentials:freeze(structuredClone(c.credentials)),
      releaseRecord:freeze(structuredClone(c.releaseRecord))};
  }
  assert(c.installationId===c.bootstrapLease.installationId);assertIndependentTrustAnchors(c.trust,c.custodyTrust);
  assert.equal(await realpath(fileURLToPath(import.meta.url)),join(await realpath(c.sourceRoot),"deploy/linux/local-target-services.ts"),
    "executing_native_source_root_changed");
  const release=await verifyInstalledRelease(c.releaseRecord,c.trust);assert(release.graph.installationId===c.installationId);
  const scopeBinding=verifyRecord(await readPrivateJSON<SignedRecord<{installationId:string;durableScope:string;generation:number;directoryMappingRecord:unknown}>>(c.installationScopeBindingFile),c.trust);
  assert(scopeBinding.installationId===c.installationId && scopeBinding.durableScope===release.graph.durableScope && scopeBinding.generation>=c.minimumGeneration,
    "explicit_original_installation_scope_binding_required");
  const directoryBinding=verifyRecord(await readPrivateJSON<SignedRecord<{
    originalLinuxInstallationId:string;directoryInstallationId:string;directoryCommunityId:string;hostingOrigin:string;
    runtimeDocumentSha256:string;acceptedReaderSourceSha256:string;readerSourceRelativePath:string;mappingRecordId:string;
  }>>(c.directoryBindingFile),c.directoryTrust);
  assert(directoryBinding.originalLinuxInstallationId===c.installationId && /^0x[a-f0-9]{64}$/.test(directoryBinding.directoryInstallationId) &&
    !/^0x0+$/.test(directoryBinding.directoryInstallationId) && directoryBinding.runtimeDocumentSha256===hash(release.graph.directoryRuntimeBinding) &&
    /^[a-f0-9]{64}$/.test(directoryBinding.acceptedReaderSourceSha256) && directoryBinding.mappingRecordId,
    "accepted_explicit_directory_installation_runtime_mapping_required");
  assert(release.sourceHashes[directoryBinding.readerSourceRelativePath]===directoryBinding.acceptedReaderSourceSha256,
    "accepted_directory_reader_not_in_actual_release_source");
  assert.deepEqual(scopeBinding.directoryMappingRecord,directoryBinding,"signed_scope_directory_mapping_record_changed");
  function assertGraphForProfile(profile:LinuxPlan["profile"]){
    assert(directoryBinding.directoryCommunityId===profile.identity.communityId && directoryBinding.hostingOrigin===profile.settings.origin,
      "original_directory_community_origin_binding_changed");
    const roles=["application","database","objects","jobs","scheduler","assets",
      ...(profile.settings.features.learning?["learning","speech-budget"]:[]),
      ...(profile.settings.features.karaoke?["karaoke"]:[]),...(profile.settings.features.dance?["private-media","dance"]:[]),
      ...(profile.settings.features.telegram?["telegram"]:[])];
    assert(roles.every(x=>release.requiredRoles.includes(x)),"selected_complete_graph_required");
    const nativeKeys=["database-v1-","objects-v1-","queue-v1-","maintenance-v1-","readback-v1-","restore-audit-v1-","boot-admission-v1-"].map(x=>x+release.graph.durableScope);
    nativeKeys.push(...release.graph.actors.flatMap(x=>x.namespaces.map(n=>n.key)));
    for(const resourceId of Object.values(profile.identity.resources)){
      const mapping=c.resourceBindings[resourceId];assert(mapping,"original_profile_resource_mapping_required");
      if(mapping.kind==="container")assert(mapping.containerKey===resourceId && c.target.containers.some(x=>x.key===mapping.containerKey),"original_container_resource_unmapped");
      else assert(nativeKeys.includes(mapping.namespaceKey) && release.graph.stateRoots[mapping.role]===c.snapshotRoots[mapping.role] &&
        Boolean(c.snapshotRoots[mapping.role]),"original_native_resource_unmapped");
    }
  }
  const lease=c.bootstrapLease;await lease.assertHeld();
  const bootstrap=await readPrivateJSON<{intent:unknown}>(join(lease.directory,lease.intentRef.relativePath));
  assert.deepEqual(bootstrap.intent,{kind:"shared-native-bootstrap",installationId:c.installationId,
    sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest,generation:c.minimumGeneration},
    "public_only_original_bootstrap_intent_required");
  assert(Object.keys(c.target.environment).every(name=>["HOME","PATH","XDG_CONFIG_HOME","DOCKER_CONFIG","TMPDIR","LC_ALL","LANG"].includes(name)),
    "managed_secret_values_must_not_use_process_environment");
  const controlRoots={operations:c.operationsDirectory,results:c.resultsDirectory,observations:c.observationDirectory,
    plans:c.plansDirectory,profiles:c.profileRecordsDirectory,inspections:c.inspectionDirectory,bootstrap:lease.directory};
  for(const [role,path] of Object.entries(release.graph.stateRoots))
    assert(c.snapshotRoots[role]===path,"complete_native_state_cohort_required");
  for(const spec of c.target.containers)for(const mount of spec.mounts)if(!mount.readOnly)
    assert(Object.values(c.snapshotRoots).some(root=>mount.source===root || mount.source.startsWith(root+"/")),
      "unaccounted_native_writable_mount");
  const capturedRoots=[...Object.values(c.snapshotRoots),...Object.values(controlRoots)];
  const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+"/")||b.startsWith(a+"/");
  assert(!Object.keys(controlRoots).some(k=>Object.hasOwn(c.snapshotRoots,k)),"control_cohort_roles_reserved");
  for(const [i,path] of capturedRoots.entries())assert(capturedRoots.slice(i+1).every(other=>!overlaps(path,other)),"cohort_roles_must_be_disjoint");
  assert(capturedRoots.every(r=>!overlaps(c.keyChannel.socket,r)),"key_channel_inside_cohort");
  assert(c.catalog.version===2 && c.namespace.version===3,"shared_native_inputs_required");
  const shared=await createSharedRuntimeReader({installationId:c.installationId,runtimeDocument:release.graph.directoryRuntimeBinding,
    bindingFile:c.directoryBindingFile,directoryTrust:c.directoryTrust,sourceRoot:c.sourceRoot,sourceHashes:release.sourceHashes,lease});
  const boundedResults=await SharedResultProducer.create({directory:c.resultsDirectory,operationsDirectory:c.operationsDirectory,
    installationId:c.installationId,minimumGeneration:c.minimumGeneration,sourceRoot:c.sourceRoot,
    releaseRecord:c.releaseRecord,trust:c.trust,custodyTrust:c.custodyTrust,bootstrapLease:lease,
    envelope:{resourceKeys:Object.keys(c.resourceBindings).sort(),requiredServices:release.requiredRoles,
      credentialCount:c.credentials.length,containers:c.target.containers.map(x=>({key:x.key,configurationDigest:x.configurationDigest}))}});
  for(const p of [c.credentialsDirectory,c.recoveryKeysDirectory,c.runtimeSecretsDirectory])assert(capturedRoots.every(r=>p!==r && !p.startsWith(r+"/") && !r.startsWith(p+"/")),"managed_keys_or_credentials_in_cohort");
  for(const p of [c.plansDirectory,c.profileRecordsDirectory,c.operationsDirectory,c.observationDirectory,c.inspectionDirectory])await privateDirectory(p);
  const channel=await createManagedKeyClient({...c.keyChannel,installationId:c.installationId,lease});
  const credentials=await createManagedCredentials({directory:c.credentialsDirectory,lease,channel,selections:c.credentials,capturedRoots:capturedRoots});
  const recovery=await createManagedRecoveryKeys({directory:c.recoveryKeysDirectory,capturedRoots:capturedRoots,
    storeId:c.recoveryKeyStoreId,masterKeyRef:c.vaultKeyRef,masterGeneration:c.vaultKeyGeneration,lease,channel});
  const authority=await createProfileAuthority({installationId:c.installationId,trust:c.trust,currentAdmissionFile:c.currentAdmissionFile,
    minimumGeneration:c.minimumGeneration,hostFingerprint:c.hostFingerprint,lease,namespace:c.namespace,shared});
  assert(release.graph.migrationPlanFile===join(release.root,"migration-plan.json"));
  const migrationPlan=JSON.parse(await readFile(release.graph.migrationPlanFile,"utf8"));
  const compatibleRuntime={sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest,
    migrations:Object.fromEntries(migrationPlan.migrations.map((m:{name:string;sha256:string})=>[m.name,"0x"+m.sha256]))};
  const backups=await createFullBackupService({stagingDirectory:c.stagingDirectory,plaintextStagingDirectory:c.plaintextStagingDirectory,
    inspectionDirectory:c.inspectionDirectory,proofFile:c.namespaceProofFile,lease,authority,keyStore:recovery,compatibleRuntime,expectedBackendSha256:canonicalDigest(release.files)});
  const inspector=await createLocalController(c.target,lease),contexts=new Map<string,OperationContext>();
  const ownedObservations=new Map<string,OperationContext>();
  let stopped=false,serial=Promise.resolve();
  async function exclusive<T>(action:()=>Promise<T>){const before=serial;let releaseLock!:()=>void;serial=new Promise(r=>{releaseLock=r;});await before;
    try{assert(!stopped);return await action();}finally{releaseLock();}}
  const planName=(id:string)=>"plan-"+evidenceId(id),operationName=(id:string)=>"operation-"+evidenceId(id);
  async function profileFor(plan:LinuxPlan) {
    const record=await readPrivateJSON<SignedRecord<ProfileAdmission>>(join(c.profileRecordsDirectory,
      "plan-authority-"+evidenceId(plan.id)+".json"));
    const proof=await readPrivateJSON<NamespaceProof>(join(c.profileRecordsDirectory,"plan-namespace-"+evidenceId(plan.id)+".json"));
    const admitted=await authority.admitCurrent(record,proof),original=admitted.original;
    assert.equal(original.profileDigest,plan.profileDigest);assertGraphForProfile(original.profile);
    return {original,namespace:admitted.namespace,record,proof};
  }
  function mutationAuthority(plan:LinuxPlan,signal:AbortSignal,own:OperationLease,requireLivePlan:boolean){
    return createCurrentMutationAuthority({plan,signal,own,requireLivePlan,authority,profileFor:()=>profileFor(plan)});
  }
  async function bind(operation:LinuxOperation):Promise<BoundLinuxIntent> {
    const stored=await readPrivateJSON<LinuxPlan>(join(c.plansDirectory,planName(operation.plan.id)+".json"));
    assert.deepEqual(planFrom(operation.plan),stored,"original_server_plan_required");await profileFor(stored);
    const config=await immutableRecord(c.plansDirectory,"configuration-"+evidenceId(operation.id),stored.profile,lease);
    const namespaceProof=await immutableRecord(c.plansDirectory,"namespace-"+evidenceId(operation.id),await readPrivateJSON(join(c.profileRecordsDirectory,"plan-namespace-"+evidenceId(stored.id)+".json")),lease);
    let value:BoundLinuxIntent;
    if(operation.kind==="restore"){
      assert(stored.restoreInspectionId);const inspection=await readPrivateJSON<any>(join(c.inspectionDirectory,stored.restoreInspectionId+".json"));
      value={kind:"restore",intent:{operationId:operation.id,journalRevision:operation.draftRevision,
        freshTarget:stored.backend.target,encryptedCohortManifest:inspection.manifestEvidence,
        transportConfiguration:config,transportCredentialRef:c.localStagingCredentialRef,
        recoveryKeyRef:inspection.keyRef,compatibleRelease:stored.backend.release,revocationPolicyDigest:canonicalDigest({policy:stored.sessionPolicy,profileDigest:stored.profileDigest}),
        executionBoundSeconds:900}} as BoundLinuxIntent;
    } else value={kind:"deploy",intent:{operationId:operation.id,journalRevision:operation.draftRevision,target:stored.backend.target,
      planDigest:stored.digest,draftRevision:operation.draftRevision,release:stored.backend.release,appOrigin:stored.profile.settings.origin,
      importedAuthorityRefs:[namespaceProof],desiredConfiguration:config,serviceSecretRefs:c.credentials.map(x=>({storeId:"managed-credentials",keyId:x.id,generation:x.generation})),
      resourceKeys:Object.values(stored.profile.identity.resources),executionBoundSeconds:900}};
    value=boundIntentFrom(value,operation);
    await boundedResults.admit(operation,value);
    await immutableRecord(c.plansDirectory,operationName(operation.id),{operation,bound:value},lease);return value;
  }
  async function context(operation:LinuxOperation,bound:BoundLinuxIntent,signal:AbortSignal){
    const prior=contexts.get(operation.id);if(prior){assert.deepEqual(prior.bound,bound);return prior;}
    const directory=join(c.operationsDirectory,evidenceId(operation.id));await mkdir(directory,{mode:0o700});
    const own=await acquireOperation(directory,operation.id,c.installationId,{operation,bound},lease.holder.pidNamespace);
    const output=join(directory,"raw");await mkdir(output,{mode:0o700});
    await mutationAuthority(operation.plan,signal,own,true)();
    await boundedResults.beginNative(operation,bound,own,{
      resourceKeys:Object.values(operation.plan.profile.identity.resources).sort(),requiredServices:release.requiredRoles,
      credentialCount:c.credentials.length,containers:c.target.containers.map(x=>({key:x.key,configurationDigest:x.configurationDigest}))},c.minimumGeneration);
    const controller=await createLocalController({...c.target,outputDirectory:output},own);
    const ctx:OperationContext={operation,bound,lease:own,controller};contexts.set(operation.id,ctx);return ctx;
  }
  function clearance(ctx:OperationContext){
    assert(ctx.readback && ctx.postguard);
    return {path:join(c.clearanceDirectory,evidenceId(ctx.operation.id)+".json"),trust:c.custodyTrust,lease:ctx.lease,
      profileDigest:ctx.operation.plan.profileDigest,generation:c.minimumGeneration,resources:ctx.operation.plan.profile.identity.resources,
      domainReadbacksSha256:ctx.readback.evidence.sha256,postguardSha256:ctx.postguard.sha256};
  }
  async function secrets(ctx:OperationContext,signal:AbortSignal){
    const values:Array<{name:string;bytes:Buffer}>=[];
    try{
      for(const mapping of c.runtimeSecrets){
        await mutationAuthority(ctx.operation.plan,signal,ctx.lease,true)();
        assert(!/GLOBAL|REGISTRY_ADMIN|CONTRACT_ADMIN|PLATFORM_LOGIN/i.test(mapping.name+" "+(mapping.keyRef??"")+" "+(mapping.credentialId??"")),"global_authority_key_forbidden");
        const receive=async(raw:Uint8Array)=>{values.push({name:mapping.name,bytes:Buffer.from(mapping.prefix+Buffer.from(raw).toString(mapping.encoding))});};
        if(mapping.credentialId){const s=c.credentials.find(x=>x.id===mapping.credentialId);assert(s);await credentials.use(s,receive);}
        else{assert(mapping.keyRef);await channel.withSecret(mapping.keyRef,mapping.generation,receive);}
        await mutationAuthority(ctx.operation.plan,signal,ctx.lease,true)();
      }
      ctx.runtimeSecrets=await materializeRuntimeSecrets({directory:c.runtimeSecretsDirectory,capturedRoots:capturedRoots,lease:ctx.lease,values,signal,assertCurrent:mutationAuthority(ctx.operation.plan,signal,ctx.lease,true)});
      for(const expected of release.graph.secretBindings)assert(ctx.runtimeSecrets.identities.some(x=>x.path===expected.path),"runtime_secret_binding_not_materialized");
      assert(ctx.runtimeSecrets.identities.some(x=>x.path===release.graph.tls.keyFile),"actual_tls_private_key_required");
    }finally{for(const value of values)value.bytes.fill(0);}
  }
  async function initialize(ctx:OperationContext,mode:"initialize"|"cold-reconcile",signal:AbortSignal){
    await mutationAuthority(ctx.operation.plan,signal,ctx.lease,true)();
    if(mode==="cold-reconcile")await writeColdPlan({path:release.graph.coldPlanFile,capturedRoots:capturedRoots,lease:ctx.lease,
      generation:c.minimumGeneration,profileDigest:ctx.operation.plan.profileDigest,resourceId:ctx.operation.plan.profile.identity.resources.database!,
      communityId:ctx.operation.plan.profile.identity.communityId,origin:ctx.operation.plan.profile.settings.origin,
      owningSourceSHA256:release.sourceHashes["services/community-application.ts"]!,queries:c.coldQueries});
    assert.equal(hash(await readFile(c.initializer.script)),c.initializer.scriptSha256,"installed_initializer_bytes_changed");
    const runtime=join(ctx.lease.directory,"native-"+mode);await mkdir(runtime,{mode:0o700});
    const ref=await createJSON(ctx.lease.directory,"native-request-"+mode,{...c.initializer.template,release:c.releaseRecord,trust:c.trust,
      mode,privateRuntimeDirectory:runtime,expectedInstallationId:c.installationId,
      configurationDirectory:c.snapshotRoots.configuration,coldReceiptPath:join(ctx.lease.directory,"cold-domain-receipt.json")});
    return runCurrentAuthorityCommand({lease:ctx.lease,executable:c.initializer.executable,executableSha256:c.initializer.sha256,
      argv:[c.initializer.script,join(ctx.lease.directory,ref.relativePath)],cwd:c.target.cwd,environment:c.target.environment,
      outputDirectory:join(ctx.lease.directory,"raw"),name:"full-"+mode,seconds:300,signal},
      mutationAuthority(ctx.operation.plan,signal,ctx.lease,true));
  }

  async function freshReadbacks(ctx:OperationContext,signal:AbortSignal,readbacks=c.readbacks,requireComplete=true){
    const captured=(await profileFor(ctx.operation.plan)).original;
    const currentRecord=await readPrivateJSON<SignedRecord<CurrentAdmission>>(c.currentAdmissionFile);
    const capturedCurrent=verifyRecord(currentRecord,c.trust);
    assert(capturedCurrent.generation===c.minimumGeneration,"actual_current_generation_required");
    const authorize=createApplicationReadbackAuthority({
      captured,capturedCurrent,signal,
      original:async()=>(await profileFor(ctx.operation.plan)).original,
      current:original=>authority.current(original),
      // This is the SAME owning guard, AFTER every application scope/key
      // preparation await. Its actual namespace TTL survives final lease/current.
      assertCurrent:mutationAuthority(ctx.operation.plan,signal,ctx.lease,false)
    });
    await authorize();
    const profile=ctx.operation.plan.profile,resourceIds=Object.values(profile.identity.resources);
    assert(readbacks.length>0 && readbacks.every(x=>resourceIds.includes(x.expected.resourceId) &&
      x.expected.installationId===c.installationId && x.expected.generation===c.minimumGeneration &&
      x.expected.profileDigest===ctx.operation.plan.profileDigest && x.expected.requestId.length>0),
      "actual_selected_handler_scope_required");
    assert(c.loginScope.origin===profile.settings.origin && c.loginScope.communityId===profile.identity.communityId && c.loginScope.chainId===profile.infrastructure.directory.chainId,"actual_shared_login_chain_changed");
    assert(c.loginProbeKeyRef.keyId!==c.readbackKeyRef.keyId,"separate_native_readback_key_required");
    let loginKeyDigest:string|undefined;
    const login=await channel.withKey(c.loginProbeKeyRef.keyId,c.loginProbeKeyRef.generation,
      async key=>{await mutationAuthority(ctx.operation.plan,signal,ctx.lease,false)();loginKeyDigest=hash(key);return actualLogin({key,scope:c.loginScope,signal,authorize});});
    await authorize();
    const specs=readbacks.map(spec=>{
      assert(["application","login","media","learning"].includes(spec.role),"actual_selected_business_role");
      const resource=profile.identity.resources[spec.role==="media"?"privateData":spec.role==="learning"?"learning":"application"];
      assert(spec.expected.resourceId===resource,"actual_selected_business_resource");
      return {...spec,expected:{...spec.expected,
        requestId:spec.role==="application"||spec.role==="login"?login.challengeId:spec.expected.requestId}};
    });
    const handlers=await channel.withKey(c.readbackKeyRef.keyId,c.readbackKeyRef.generation,
      async probeKey=>{await mutationAuthority(ctx.operation.plan,signal,ctx.lease,false)();assert(hash(probeKey)!==loginKeyDigest,"separate_native_readback_key_required");return runActualReadbacks({lease:ctx.lease,specs,
        authorize,current:currentRecord,readbackKey:Buffer.from(probeKey).toString("hex"),
        owningSourceSHA256:release.sourceHashes["services/community-application.ts"]!,
        headers:{Cookie:login.cookie,"X-Pirate-Readback-Key":Buffer.from(probeKey).toString("hex"),
          "X-Study-Account":login.wallet},
        profileDigest:ctx.operation.plan.profileDigest,origin:profile.settings.origin,generation:c.minimumGeneration,signal});});
    const selected=["application","login","media",...(profile.settings.features.learning?["learning"]:[])];
    assert(!requireComplete || selected.every(role=>handlers.observations.some(x=>x.role===role)),"complete_actual_handler_readbacks_required");
    ctx.sharedConfiguration=await shared.read(profile,ctx.lease,signal);
    await profileFor(ctx.operation.plan);
    const evidence=await ctx.lease.record(requireComplete?"actual-full-shared-domain-readbacks":"actual-partial-business-readbacks",{originalOperationId:ctx.operation.id,
      profileDigest:ctx.operation.plan.profileDigest,generation:c.minimumGeneration,
      handlers:handlers.evidence,directory:ctx.sharedConfiguration.evidence});
    ctx.readback={...handlers,evidence,checkedAt:Math.min(handlers.checkedAt,ctx.sharedConfiguration.checkedAt)};
    return {...ctx.readback,session:login};
  }
  async function actualClearance(ctx:OperationContext,suffix=""){
    assert(ctx.readback && ctx.postguard);
    const required={...clearance(ctx),path:join(c.clearanceDirectory,evidenceId(ctx.lease.operationId)+suffix+".json")};
    await ctx.lease.record("independent-current-clearance-request",{path:required.path,operationId:ctx.lease.operationId,
      originalOperationId:ctx.operation.id,profileDigest:required.profileDigest,resources:required.resources,
      generation:required.generation,domainReadbacksSha256:required.domainReadbacksSha256,postguardSha256:required.postguardSha256});
    const end=performance.now()+5000;let timedOut=false;
    for(;;){
      if(timedOut||performance.now()>=end){timedOut=true;throw Error("independent_current_clearance_pending");}
      try{
        const proof=await readWholeClearance(required);
        if(performance.now()>=end){timedOut=true;throw Error("independent_current_clearance_timeout");}
        ctx.clearanceRequest=required;return {proof,required};
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        await new Promise(resolve=>setTimeout(resolve,Math.min(50,Math.max(1,end-performance.now()))));
      }
    }
  }
  let readbackSequence=0;
  async function observationContext(operation:LinuxOperation,purpose:string):Promise<OperationContext>{
    assert(++readbackSequence<=64,"native_observation_session_limit");
    const id=purpose+"-"+evidenceId(operation.id+"|"+lease.intentRef.sha256+"|"+String(readbackSequence));
    const directory=join(c.observationDirectory,id);await mkdir(directory,{mode:0o700});
    const own=await acquireOperation(directory,id,c.installationId,{purpose,originalOperation:operation.id,
      profileDigest:operation.plan.profileDigest,planDigest:operation.plan.digest,
      bootstrapIntent:lease.intentRef},lease.holder.pidNamespace);
    const raw=join(directory,"raw");await mkdir(raw,{mode:0o700});
    const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(operation.id)+".json"));
    assert.deepEqual(stored.operation,operation);
    const observed:OperationContext={operation,bound:stored.bound,lease:own,
      controller:await createLocalController({...c.target,outputDirectory:raw},own)};
    ownedObservations.set(own.operationId,observed);return observed;
  }
  async function actualOriginal(operation:LinuxOperation,bound:BoundLinuxIntent){
    const actual=await boundedResults.terminal({operation,retainedIntent:bound});
    assert(actual.state==="result","original_native_result_pending");
    return actual.result;
  }
  async function finish(ctx:OperationContext,resources:LinuxOperationResult["resources"],failure:unknown,phases:string[],signal:AbortSignal){
    // A closed original is immutable, including after an ordinary observation.
    // New maintenance/restart effects require a separately admitted operation.
    if(ctx.result)return structuredClone(ctx.result);
    if(signal.aborted)failure??=Error("native_operation_execution_bound");
    let guard=false;try{await verifyInstalledRelease(c.releaseRecord,c.trust);await profileFor(ctx.operation.plan);guard=true;}catch(e){failure??=e;}
    if(!ctx.postguard)ctx.postguard=await ctx.lease.record("mandatory-source-authority-postguard",{matched:guard,sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest});
    let clear=false;
    if(!failure && ctx.readback)try{await actualClearance(ctx);clear=true;}catch{}
    if(signal.aborted){failure??=Error("native_operation_execution_bound");clear=false;}
    const cleanup=await ctx.lease.record("owned-cleanup-observation",{independentWholeHostClear:clear,leaseRetained:true,uncertainty:!clear});
    const raw=await ctx.lease.record("operation-terminal",{failed:failure!==undefined,completed:phases,independentWholeHostClear:clear});
    const result:LinuxOperationResult={operationId:ctx.operation.id,outcome:clear&&!failure?"completed":"custody-uncertain",
      lastCompletedPhase:phases.at(-1)??null,unrunPhases:failure?["remaining-application-and-release"]:[],resources,ownedProcesses:[],
      rawReceipt:raw,postguard:ctx.postguard,cleanup};
    await boundedResults.closeNative(ctx.lease,result,clear?clearance(ctx):null);
    ctx.result=result;ctx.failure=failure;ctx.revision=(ctx.revision??0)+1;return result;
  }
  async function perform(value:BoundLinuxIntent,signal:AbortSignal) {
    signal=AbortSignal.any([signal,AbortSignal.timeout(value.intent.executionBoundSeconds*1000)]);
    boundedIntent(value);
    const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(value.intent.operationId)+".json"));
    assert.deepEqual(stored.bound,value);
    const retained=await boundedResults.terminal({operation:stored.operation,retainedIntent:value});
    if(retained.state==="result")return retained.result;
    try{await lstat(join(c.operationsDirectory,evidenceId(stored.operation.id)));
      throw Error("original_native_dispatch_already_pending");
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    assert(stored.operation.plan.expiresAt>Date.now() && !signal.aborted,"original_plan_expired_before_dispatch");
    await mutationAuthority(stored.operation.plan,signal,lease,true)();
    const ctx=await context(stored.operation,value,signal),phases:string[]=[],resources:any[]=[];let failure:unknown;
    try{
      const actual=await profileFor(stored.operation.plan);assert(!signal.aborted && stored.operation.plan.expiresAt>Date.now(),"original_plan_expired_before_effects");
      const before=await ctx.controller.inspect(signal);assert.equal(before.fingerprint,stored.operation.plan.targetFingerprint);phases.push("current-target-authority");
      assert(!signal.aborted && stored.operation.plan.expiresAt>Date.now(),"original_plan_expired_before_effects");
      await mutationAuthority(stored.operation.plan,signal,ctx.lease,true)();
      await secrets(ctx,signal);phases.push("authenticated-current-runtime-secrets");
      if(value.kind==="restore"){
        assert(stored.operation.plan.restoreInspectionId);
        const inspected=await readPrivateJSON<any>(join(c.inspectionDirectory,stored.operation.plan.restoreInspectionId+".json"));
        assert.deepEqual([...Object.keys(c.snapshotRoots),...Object.keys(controlRoots)].sort(),[...inspected.roles].sort(),"complete_restore_roles_required");
        for(const [role,root] of Object.entries(c.snapshotRoots))assert(root===join(c.freshRestoreTarget,role),"fresh_role_mapping_changed");
        await backups.restoreBytes({inspectionId:stored.operation.plan.restoreInspectionId,freshTarget:c.freshRestoreTarget,signal,
          assertCurrent:mutationAuthority(stored.operation.plan,signal,ctx.lease,true)});
        await ctx.lease.record("retained-original-control-cohort",{manifestSha256:inspected.inspection.manifestDigest,
          roles:Object.fromEntries(Object.keys(controlRoots).map(role=>[role,join(c.freshRestoreTarget,role)])),
          disposition:"authenticated-retained-history-not-merged-into-live-control"});
        phases.push("authenticated-original-fenced-extraction");
        await initialize(ctx,"cold-reconcile",signal);
        const cold=await readPrivateJSON<any>(join(ctx.lease.directory,"cold-domain-receipt.json"));
        assert(cold.installationId===c.installationId && cold.reply.outcome==="offline-reconciled" &&
          cold.reply.profileDigest===stored.operation.plan.profileDigest && cold.reply.requestId===stored.operation.id &&
          cold.reply.generation===c.minimumGeneration,"actual_original_cold_domain_readback_required");
        const evidence=await ctx.lease.record("actual-cold-domain-readback",cold.reply);
        ctx.readback={observations:[{role:"session-revocation",observed:cold.reply,responseSHA256:hash(JSON.stringify(cold.reply)),certificateFingerprint:"private-native-UDS"}],evidence,checkedAt:Date.now()};
        ctx.postguard=await ctx.lease.record("cold-source-authority-postguard",{release:release.artifactDigest,profileDigest:stored.operation.plan.profileDigest});
        await profileFor(stored.operation.plan);
        await releaseRestoredFences({target:c.freshRestoreTarget,roles:inspected.roles,
          archiveSha256:inspected.inspection.ciphertextDigest.slice(2),manifestSha256:inspected.inspection.manifestDigest.slice(2),lease:ctx.lease,
          clearance:{...clearance(ctx),path:join(c.clearanceDirectory,evidenceId(stored.operation.id)+"-cold.json")},
          signal,assertCurrent:mutationAuthority(stored.operation.plan,signal,ctx.lease,true)});
        phases.push("current-original-domain-authority-and-fence-release");ctx.readback=undefined;ctx.postguard=undefined;
      } else {
        if(before.resources.every(x=>x.actual===null)){
          await mutationAuthority(stored.operation.plan,signal,ctx.lease,true)();await mkdir(c.freshRestoreTarget,{mode:0o700});
          for(const [role,path] of Object.entries(c.snapshotRoots)){assert(path===join(c.freshRestoreTarget,role));
            await mutationAuthority(stored.operation.plan,signal,ctx.lease,true)();await mkdir(path,{mode:0o700});}
          await authority.commitOriginal(c.snapshotRoots.configuration!,actual.record,actual.proof);
          await initialize(ctx,"initialize",signal);phases.push("native-selected-migrations");
        }
      }
      if(before.resources.every(x=>x.actual===null))await ctx.controller.create(signal,mutationAuthority(stored.operation.plan,signal,ctx.lease,true));
      const started=await ctx.controller.start(signal,mutationAuthority(stored.operation.plan,signal,ctx.lease,true));phases.push("full-service-start");
      for(const r of started.resources)resources.push({resourceKey:r.spec.key,intentId:value.intent.operationId,targetIdentityDigest:stored.operation.plan.targetFingerprint,
        disposition:"owned-present",observedConfigurationDigest:r.spec.configurationDigest,
        evidence:await ctx.lease.record("resource-readback-"+evidenceId(r.spec.key),{id:r.actual.Id,state:r.actual.State,key:r.spec.key})});
      await freshReadbacks(ctx,signal);
      phases.push("actual-selected-handler-readbacks");
    }catch(e){failure=e;}
    return finish(ctx,resources,failure,phases,signal);
  }
  const services:LinuxSharedBackendServices={
    adapterId:c.adapterId,sourceDigest:release.sourceDigest,maxStagedCiphertextBytes:MAX_CIPHERTEXT_BYTES,boundedResults:boundedResults,
    custody:{assertHeld:()=>lease.assertHeld()},catalog:{async capabilities(){await lease.assertHeld();assert(c.catalog.sourceDigest===release.sourceDigest);
      const actual=structuredClone(c.catalog);actual.targets=["local-linux"];actual.operations=["create","import","restore","upgrade"];
      for(const p of [...actual.publicationProfiles,...actual.learningProfiles])p.verified=await credentials.profileVerified(p.id);
      for(const p of actual.publicationProfiles)if(!p.verified)p.verified=await configuredPublisherVerified({profileId:p.id,installationId:c.installationId,
        admissionFile:c.publisherAdmissionFile,trust:c.directoryTrust,channel});
      actual.backupProfiles.sort((a,b)=>Number(b.profile.provider==="filebase-private")-Number(a.profile.provider==="filebase-private"));return actual;}},
    targets:{async inspectTarget(request){return exclusive(async()=>{
      assert(request.target.kind==="local-linux","ssh_target_not_qualified");const actual=await inspector.inspectHost(AbortSignal.timeout(30000));
      assert.equal(actual.fingerprint,c.hostFingerprint);
      const existing:LinuxPlan["profile"][]=[];let originalAuthorized=true;
      if(actual.resources.some(x=>x.actual)){
        try{const signed=await readPrivateJSON<SignedRecord<ProfileAdmission>>(join(c.snapshotRoots.configuration!,"profile-authority.json"));
          const admitted=await authority.admit(signed,await readPrivateJSON<NamespaceProof>(c.namespaceProofFile));assertGraphForProfile(admitted.profile);existing.push(admitted.profile);
        }catch{originalAuthorized=false;}
      }
      return {id:"target-"+evidenceId(request.requestId),target:request.target,fingerprint:actual.fingerprint,
        description:"Actual installed local Linux/Docker target",corrections:[...actual.corrections,...(originalAuthorized?[]:["Actual resources exist; authenticate and reconcile their original full profile before creating or adopting anything."])],
        existing,supported:actual.supported&&originalAuthorized,
        prepared:existing.length?{identity:existing[0]!.identity,infrastructure:existing[0]!.infrastructure,settings:existing[0]!.settings}:
          await (async()=>{const t=await readProfileTemplate(c.profileTemplateFile,c.trust,c.installationId);
            assert(t.generation===c.minimumGeneration && t.runtime.sourceDigest===release.sourceDigest &&
              t.runtime.artifactDigest===release.artifactDigest,"signed_template_release_changed");
            return {identity:t.identity,infrastructure:t.infrastructure,settings:t.settings};})()};
    });}},
    credentials:{
      credentialRequirements:credentials.credentialRequirements,
      saveCredentials:r=>exclusive(()=>credentials.saveCredentials(r)),
      verifyCredentials:r=>exclusive(()=>credentials.verifyCredentials(r)),
      reconcileCredentials:r=>exclusive(()=>credentials.reconcileCredentials(r))
    },backups:{stageBackup:r=>exclusive(()=>backups.stageBackup(r)),inspectBackup:r=>exclusive(()=>backups.inspectBackup(r))},
    lifecycle:{
      async prepare(provided){const request=structuredClone(provided);return exclusive(async()=>{
        assert(request.target.target.kind==="local-linux" && request.target.supported && request.target.fingerprint===c.hostFingerprint);
        let predecessorRecord:SignedRecord<ProfileAdmission>|undefined;
        if(request.previousOperation){
          const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(request.previousOperation.id)+".json"));
          const result=await actualOriginal(stored.operation,stored.bound);
          retainedReview({requested:request.previousOperation,stored,result,retainedIdentity:request.retainedIdentity,
            sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest,fingerprint:c.hostFingerprint});
          predecessorRecord=(await profileFor(stored.operation.plan)).record; // Actual current signed policy/source/namespace, not a UI predecessor flag.
        }
        let record:SignedRecord<ProfileAdmission>;
        if(request.draft.mode==="restore") {
          assert(request.restore,"authenticated_original_restore_inspection_required");
          const inspected=await readPrivateJSON<any>(join(c.inspectionDirectory,request.restore.id+".json"));
          assert.deepEqual(inspected.inspection,request.restore,"original_authenticated_restore_inspection_required");
          assert(inspected.inspection.sessionPolicies.includes(request.draft.recovery.sessionPolicy) &&
            c.catalog.backup.sessionPolicies.includes(request.draft.recovery.sessionPolicy),"actual_restore_policy_required");
          await authority.restore(inspected.originalAuthority,request.restore.profile,request.namespace);
          const original=request.restore.profile;
          assert(sameOperationalSelection(original.settings,request.draft,request.draft.recovery.sessionPolicy),"restore_original_settings_or_explicit_migration_required");
          record=inspected.originalAuthority;
        } else if(request.draft.mode==="import"){
           assert(request.imported,"authenticated_original_import_profile_required");
           record=await readPrivateJSON<SignedRecord<ProfileAdmission>>(join(c.snapshotRoots.configuration!,"profile-authority.json"));
           const admitted=await authority.restore(record,request.imported,request.namespace);
           assert(request.draft.recovery.sessionPolicy===admitted.profile.settings.recovery.sessionPolicy &&
             sameOperationalSelection(admitted.profile.settings,request.draft,request.draft.recovery.sessionPolicy),
             "import_original_settings_or_explicit_migration_required");
         } else if(predecessorRecord && sameOperationalSelection(predecessorRecord.body.profile.settings,request.draft,request.draft.recovery.sessionPolicy)){
          record=predecessorRecord;await authority.admitCurrent(record,request.namespace);
         } else record=await produceOriginalProfile({templateFile:c.profileTemplateFile,trust:c.trust,requestId:request.requestId,draft:request.draft,
          proof:request.namespace,retainedIdentity:request.retainedIdentity,outputDirectory:c.profileRecordsDirectory,lease,channel,authority});
        await immutableRecord(c.profileRecordsDirectory,"plan-authority-"+evidenceId(request.requestId),record,lease);
         await immutableRecord(c.profileRecordsDirectory,"plan-namespace-"+evidenceId(request.requestId),request.namespace,lease);
        const profile=record.body.profile;assert(record.body.generation===c.minimumGeneration,"selected_native_generation_changed");assert(profile.runtime.sourceDigest===release.sourceDigest && profile.runtime.artifactDigest===release.artifactDigest);
        const requirements=await credentials.credentialRequirements({draft:request.draft});
        const evidence=await immutableRecord(c.plansDirectory,"release-"+evidenceId(request.requestId),c.releaseRecord,lease);
        const current=await authority.current(record.body);
        const preimage={id:request.requestId,profileDigest:canonicalDigest(profile),expiresAt:Math.min(current.expiresAt,request.namespace.expiresAt,Date.now()+60000),
          backend:{target:{endpointRef:"local-installed",endpointIdentityDigest:c.hostFingerprint,stateNamespace:c.installationId,deploymentId:profile.identity.deploymentId},
            release:{sourceHead:release.sourceHead,sourceTree:release.sourceTree,manifest:evidence,selectedProfileDigest:canonicalDigest(profile),requiredServices:release.requiredRoles}},
          profile,operatorPolicy:structuredClone(c.catalog.policy),targetInspectionId:request.target.id,targetFingerprint:c.hostFingerprint,namespaceProofId:request.namespace.id,
          action:request.draft.mode==="restore"?"restore" as const:request.previousOperation?"upgrade" as const:request.draft.mode==="import"?"adopt" as const:"create" as const,
          changes:["Run the actual complete selected local service graph"],warnings:[],requirements,
          restoreInspectionId:request.restore?.id??null,restoreManifestDigest:request.restore?.manifestDigest??null,
          restoreCiphertextDigest:request.restore?.ciphertextDigest??null,predecessorOperationId:request.previousOperation?.id??null,sessionPolicy:request.draft.recovery.sessionPolicy};
        const plan=planFrom({...preimage,digest:canonicalDigest(preimage)});await immutableRecord(c.plansDirectory,planName(plan.id),plan,lease);
        // Last await is the established fresh current/namespace/lease guard.
        // Every new predecessor/template/credential/plan-write await is before it.
        await mutationAuthority(plan,AbortSignal.timeout(45000),lease,true)();
        assert.deepEqual(provided,request,"original_prepare_request_changed");
        return plan;
      });},
      bindOperation:operation=>exclusive(()=>bind(operation)),
      async bindReconciliation({operation,retainedIntent}){
        const stored=await readPrivateJSON<any>(join(c.plansDirectory,operationName(operation.id)+".json"));
        assert.deepEqual(stored.operation,operation);if(retainedIntent)assert.deepEqual(stored.bound,retainedIntent);
        const ref={relativePath:operationName(operation.id)+".json",sha256:hash(JSON.stringify(stored)+"\n")};
        return reconciliationFrom({operationId:operation.id,journalRevision:operation.draftRevision,target:operation.plan.backend.target,
          intents:[ref],executionBoundSeconds:180},operation);
      }
    },
    intents:{
      async assertBound(value){const stored=await readPrivateJSON<any>(join(c.plansDirectory,operationName(value.intent.operationId)+".json"));assert.deepEqual(stored.bound,value);},
      async assertReconciliation(value){const stored=await readPrivateJSON<any>(join(c.plansDirectory,operationName(value.operationId)+".json"));reconciliationFrom(value,stored.operation);}
    },
    authority:{
      async assertCurrent(plan){await profileFor(plan);},
      async assertCurrentIntent(value){const stored=await readPrivateJSON<any>(join(c.plansDirectory,operationName(value.intent.operationId)+".json"));await profileFor(stored.operation.plan);}
    },
    operator:{
      deploy:(intent,signal)=>exclusive(()=>perform({kind:"deploy",intent},signal)),
      restore:(intent,signal)=>exclusive(()=>perform({kind:"restore",intent},signal)),
      async reconcile(request,signal){
        await lease.assertHeld();assert(!signal.aborted);
        const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(request.operationId)+".json"));
        reconciliationFrom(request,stored.operation);
        return actualOriginal(stored.operation,stored.bound);
      }
    },
    postReadback:{async observe({operation,result}){
      return exclusive(async()=>{
        const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(operation.id)+".json"));
        assert.deepEqual(stored.operation,operation);assert.deepEqual(await actualOriginal(operation,stored.bound),result,
          "actual_original_terminal_receipt_required");
        if(result.outcome!=="completed")return {operationId:operation.id,planDigest:operation.plan.digest,
          profileDigest:operation.plan.profileDigest,targetFingerprint:operation.plan.targetFingerprint,
          sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest,
          observation:{state:"unknown" as const,revision:++readbackSequence,custody:"held" as const,receiptRef:result.rawReceipt.relativePath,
            correction:"Original native uncertainty remains retained; current owning reconciliation is required."}};
        await profileFor(operation.plan);
        const ctx=await observationContext(operation,"observe"),signal=AbortSignal.timeout(180000);
        const inspected=await ctx.controller.inspect(signal);
        assert.equal(inspected.fingerprint,operation.plan.targetFingerprint);
        for(const r of result.resources){
          const actual=inspected.resources.find(x=>x.spec.key===r.resourceKey);
          if(actual)assert(r.disposition==="owned-present"?actual.actual!==null:r.disposition==="confirmed-absent"&&actual.actual===null,
            "current_original_resource_disposition_changed");
        }
        await freshReadbacks(ctx,signal);
        ctx.postguard=await ctx.lease.record("current-shared-source-authority-postguard",{sourceDigest:release.sourceDigest,
          artifactDigest:release.artifactDigest,profileDigest:operation.plan.profileDigest});
        let cleared=false;
        try{await actualClearance(ctx);await profileFor(operation.plan);await readWholeClearance({
          ...clearance(ctx),path:join(c.clearanceDirectory,evidenceId(ctx.lease.operationId)+".json")});cleared=true;}
        catch(error){if(!(error instanceof Error && error.message==="independent_current_clearance_pending"))throw error;}
        assert(!signal.aborted,"current_readback_true_timeout");
        const observation:LinuxObservation=cleared?{state:"succeeded",revision:readbackSequence,custody:"cleared",
          receiptRef:result.rawReceipt.relativePath,identity:operation.plan.profile.identity,profileDigest:operation.plan.profileDigest,
          recovery:operation.kind==="restore"?{inspectionId:operation.plan.restoreInspectionId!,manifestDigest:operation.plan.restoreManifestDigest!,sessionPolicy:operation.plan.sessionPolicy}:null,
          sharedConfiguration:(()=>{const {directory,configuration,evidenceRef,blockNumber,blockHash}=ctx.sharedConfiguration!;
            return {directory,configuration,evidenceRef,blockNumber,blockHash};})(),
          health:{origin:operation.plan.profile.settings.origin,
            application:ctx.readback!.observations.some(x=>x.role==="application"),
            login:ctx.readback!.observations.some(x=>x.role==="login"),media:ctx.readback!.observations.some(x=>x.role==="media"),
            learning:!operation.plan.profile.settings.features.learning || ctx.readback!.observations.some(x=>x.role==="learning"),
            checkedAt:ctx.readback!.checkedAt}}:
          {state:"unknown",revision:readbackSequence,custody:"held",receiptRef:result.rawReceipt.relativePath,
            correction:"Fresh application/Directory observations are retained; independent whole-host/resource/domain clearance is pending."};
        return {operationId:operation.id,planDigest:operation.plan.digest,profileDigest:operation.plan.profileDigest,
          targetFingerprint:operation.plan.targetFingerprint,sourceDigest:release.sourceDigest,artifactDigest:release.artifactDigest,observation};
      });
    }}
  };
  boundedResults.attachNative(services.operator);
  const complete=createSharedLinuxDeploymentPort(services);
  return {
    complete,services,controller:inspector,
    // Internal native client helper; no new wizard/HTTP permission or readiness.
    // It uses this SAME factory, original journal and live authority/key owners.
    async applicationBusinessReadback(request:{operationId:string;role:"application"|"media"|"learning";path:string;
      requestId:string;outcome:string;signal:AbortSignal}){return exclusive(async()=>{
      const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(request.operationId)+".json"));
      await actualOriginal(stored.operation,stored.bound);await profileFor(stored.operation.plan);
      const profile=stored.operation.plan.profile,ctx=await observationContext(stored.operation,"application-business-read");
      const resource=profile.identity.resources[request.role==="media"?"privateData":request.role==="learning"?"learning":"application"];
      assert(resource && request.requestId && request.outcome);
      const spec:ReadbackSpec={role:request.role,url:profile.settings.origin+request.path,method:"GET",expectedStatus:200,
        sourceSHA256:release.sourceHashes["services/community-application.ts"]!,
        selectors:{installationId:"/nativeReadback/installationId",resourceId:"/nativeReadback/resourceId",
          requestId:"/nativeReadback/requestId",generation:"/nativeReadback/generation",outcome:"/nativeReadback/outcome",profileDigest:"/nativeReadback/profileDigest"},
        expected:{installationId:c.installationId,resourceId:resource,requestId:request.requestId,generation:c.minimumGeneration,
          outcome:request.outcome,profileDigest:stored.operation.plan.profileDigest}};
      const sessionSpec:ReadbackSpec={...spec,role:"application",url:profile.settings.origin+"/api/session",
        expected:{...spec.expected,resourceId:profile.identity.resources.application!,requestId:"actual-login",outcome:"authenticated"}};
      const value=await freshReadbacks(ctx,request.signal,request.role==="application"?[spec]:[sessionSpec,spec],false);
      assert(value.accountId,"actual_authenticated_account_required");
      return {session:value.session,accountId:value.accountId,observations:value.observations,evidence:value.evidence};
    });},

    async stop(operationId:string,signal:AbortSignal){return exclusive(async()=>{
      const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(operationId)+".json"));
      await actualOriginal(stored.operation,stored.bound);await profileFor(stored.operation.plan);
      const ctx=await observationContext(stored.operation,"stop");await freshReadbacks(ctx,signal);
      const stopped=await ctx.controller.stop(signal,mutationAuthority(ctx.operation.plan,signal,ctx.lease,false));
      ctx.postguard=await ctx.lease.record("actual-stopped-source-postguard",{profileDigest:stored.operation.plan.profileDigest,barrier:stopped.receipt});
      await actualClearance(ctx,"-stopped");await profileFor(stored.operation.plan);
      return stopped; // Actual all-writer barrier stays held.
    });},
    async restart(operationId:string,signal:AbortSignal){return exclusive(async()=>{
      const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(operationId)+".json"));
      const original=await actualOriginal(stored.operation,stored.bound);await profileFor(stored.operation.plan);
      const ctx=await observationContext(stored.operation,"restart");
      await freshReadbacks(ctx,signal);
      const stopped=await ctx.controller.stop(signal,mutationAuthority(ctx.operation.plan,signal,ctx.lease,false));
      ctx.postguard=await ctx.lease.record("restart-source-and-writer-postguard",{release:release.artifactDigest,barrier:stopped.receipt});
      const approved=await actualClearance(ctx,"-stopped");await profileFor(stored.operation.plan);
      await releaseOwnedMaintenance({directory:c.target.maintenanceDirectory,lease:ctx.lease,clearance:approved.required,
        signal,assertCurrent:mutationAuthority(ctx.operation.plan,signal,ctx.lease,false)});
      // Starting the exact owned containers reuses their authenticated original
      // secret mounts. This call never adopts/rewrites/disposes a dead owner's
      // key files or provisions replacement credentials.
      await ctx.controller.start(signal,mutationAuthority(ctx.operation.plan,signal,ctx.lease,false));await freshReadbacks(ctx,signal);
      ctx.postguard=await ctx.lease.record("actual-shared-post-restart-postguard",{release:release.artifactDigest,profileDigest:stored.operation.plan.profileDigest});
      await actualClearance(ctx,"-started");await profileFor(stored.operation.plan);
      await ctx.lease.record("actual-shared-service-restart-observed",{originalOperationId:operationId,
        originalResultSha256:hash(JSON.stringify(original)+"\n"),handlers:ctx.readback!.evidence,
        directory:ctx.sharedConfiguration!.evidence,originalResultUnchanged:true});
      return original;
    });},
    async createBackup(request:{operationId:string;requestId:string;operationLease:OperationLease;output:string;recoveryKey:string;controlStaging:string;signal:AbortSignal}){return exclusive(async()=>{
      const stored=await readPrivateJSON<{operation:LinuxOperation;bound:BoundLinuxIntent}>(join(c.plansDirectory,operationName(request.operationId)+".json"));
      await actualOriginal(stored.operation,stored.bound);await profileFor(stored.operation.plan);
      const ctx=await observationContext(stored.operation,"backup-read");await freshReadbacks(ctx,request.signal);
      const backupLease=request.operationLease;await backupLease.assertHeld();
      assert(backupLease.installationId===c.installationId && backupLease.operationId!==ctx.lease.operationId &&
        capturedRoots.every(root=>!overlaps(backupLease.directory,root)),"separate_original_backup_operation_required");
      const backupIntent=await readPrivateJSON<{intent:unknown}>(join(backupLease.directory,backupLease.intentRef.relativePath));
      assert.deepEqual(backupIntent.intent,{kind:"full-backup",requestId:request.requestId,predecessorOperationId:request.operationId,
        profileDigest:ctx.operation.plan.profileDigest,output:request.output,controlStaging:request.controlStaging},"original_backup_intent_required");
      assert(capturedRoots.every(root=>!overlaps(request.controlStaging,root) && !overlaps(request.output,root)),"backup_output_inside_captured_cohort");
      await immutableRecord(c.inspectionDirectory,"backup-intent-"+evidenceId(request.requestId),{requestId:request.requestId,operationId:backupLease.operationId,
        predecessorOperationId:ctx.operation.id,profileDigest:ctx.operation.plan.profileDigest,output:request.output,controlStaging:request.controlStaging},backupLease);
      const raw=join(backupLease.directory,"raw");await mkdir(raw,{mode:0o700});
      const backupController=await createLocalController({...c.target,outputDirectory:raw},backupLease);
      const stopped=await backupController.stop(request.signal,mutationAuthority(ctx.operation.plan,request.signal,backupLease,false));
      const backupContext:OperationContext={...ctx,lease:backupLease,controller:backupController,
        postguard:await backupLease.record("full-backup-source-writer-postguard",{profileDigest:ctx.operation.plan.profileDigest,barrier:stopped.receipt})};
      await actualClearance(backupContext,"-stopped");ctx.clearanceRequest=backupContext.clearanceRequest;
      await mkdir(request.controlStaging,{mode:0o700});
      const roots={...c.snapshotRoots};
      for(const [role,source] of Object.entries(controlRoots)){
        const frozen=await copyControlCohort({source,target:join(request.controlStaging,role),lease:backupLease});
        roots[role]=frozen.target;
      }
      const identity={deploymentId:ctx.operation.plan.profile.identity.deploymentId,releaseSha256:release.artifactDigest.slice(2),
        backendSha256:canonicalDigest(release.files),profileSha256:ctx.operation.plan.profileDigest,
        origin:ctx.operation.plan.profile.settings.origin,communityId:ctx.operation.plan.profile.identity.communityId,writerFenceSha256:stopped.receipt.sha256};
      const barrier={receipt:stopped.receipt,async assertCold(){await stopped.maintenance.assertMaintenanceHeld();
        const snapshot=await backupController.inspect(request.signal);assert(snapshot.resources.every(x=>x.actual && !x.actual.State.Running && x.actual.State.Pid===0 && x.actual.State.ExitCode===0));return stopped.receipt;}};
      await syncDirectory(request.controlStaging);assert(!request.signal.aborted,"full_backup_true_timeout");
      await mutationAuthority(ctx.operation.plan,request.signal,backupLease,false)();
      const sealed=await backups.capture({output:request.output,recoveryKey:request.recoveryKey,identity,roots,barrier,operationLease:backupLease});
      await profileFor(ctx.operation.plan);assert(!request.signal.aborted,"full_backup_true_timeout");
      const receipt={archiveSha256:sealed.archiveSha256,manifestSha256:sealed.manifestSha256,encryptedBytes:sealed.encryptedBytes,output:sealed.output,
        sourceMachineIdSha256:hash(await readFile("/etc/machine-id")),identity,roles:Object.keys(roots).sort(),writerFenceSha256:stopped.receipt.sha256};
      await backupLease.record("complete-local-backup-created",receipt);await backupController.dispose();return receipt;
    });},
    async exportBackup(request:{operationId:string;receipt:Parameters<typeof exportEncryptedBackup>[0]["receipt"];approvalFile:string;signal:AbortSignal}){return exclusive(async()=>{
      const ctx=contexts.get(request.operationId);assert(ctx);const selected=c.credentials.find(x=>x.role==="backup");assert(selected);
      return credentials.use(selected,bytes=>exportEncryptedBackup({lease:ctx.lease,receipt:request.receipt,
        profile:ctx.operation.plan.profile.settings.storage.backup,credentials:JSON.parse(bytes.toString("utf8")),signal:request.signal,ticketDirectory:ctx.lease.directory,
        authorizeProviderWrite:async()=>{await profileFor(ctx.operation.plan);const approval=verifyRecord(await readPrivateJSON<SignedRecord<any>>(request.approvalFile),c.trust);
          assert(approval.action==="export-encrypted-backup" && approval.installationId===c.installationId && approval.operationId===request.operationId &&
            approval.archiveSha256===request.receipt.archiveSha256 && approval.expiresAt>Date.now(),"actual_provider_write_approval_required");}}));
    });},
    async close(){await serial;
      const current=[...contexts.values(),...ownedObservations.values()];
      let latest:OperationContext|undefined;
      for(const ctx of [...current].reverse())if(ctx.clearanceRequest){
        await readWholeClearance(ctx.clearanceRequest);latest=ctx;break;
      }
      assert(current.length===0 || latest?.clearanceRequest,"current_owning_cleanup_authority_pending");
      let runtimeSecretsRetained=false;
      if(latest?.clearanceRequest){
        const actual=await latest.controller.inspect(AbortSignal.timeout(30000));
        const allStopped=actual.resources.every(x=>x.actual===null || !x.actual.State.Running && x.actual.State.Pid===0);
        for(const ctx of contexts.values())if(ctx.runtimeSecrets){
          assert(ctx.operation.plan.profileDigest===latest.operation.plan.profileDigest,"runtime_secret_profile_custody_changed");
          if(allStopped)await ctx.runtimeSecrets.dispose(latest.clearanceRequest);
          else{
            runtimeSecretsRetained=true;
            await ctx.lease.record("runtime-secrets-retained-for-intended-services",{identities:ctx.runtimeSecrets.identities,
              currentWholeAuthority:latest.lease.intentRef,originalLeaseRetained:true});
          }
        }
      }
      for(const ctx of current)await ctx.controller.dispose();
      credentials.dispose();channel.dispose();await inspector.dispose();stopped=true;
      // Disconnecting an operator does not delete credentials needed by live
      // intended services. Only exact owned file identities after actual stop
      // and current independent authority are disposed. No leases are stolen.
      return {runtimeSecrets:runtimeSecretsRetained?"retained-for-intended-services":"disposed-or-none",originalLeases:"retained"};
    }

  };
}

