// Public codec fixtures only. Explicit V3 construction; no product conversion,
// authority, provider, host or readiness claim. Existing V2 fixture is unchanged.
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {linuxCreateProfileFrom,type LinuxCreateProfileV3} from "../packages/community-setup/linux-create-profile.ts";
import {digestJson} from "../apps/community-wizard/server/linux-journal.ts";
import {planFrom} from "../apps/community-wizard/server/linux-boundaries.ts";
import type {OriginalLinuxPlan as LinuxPlan,OriginalLinuxOperation as LinuxOperation} from "../apps/community-wizard/server/linux-contracts.ts";
export function createProfileFixture(original=fixtureProfile()):LinuxCreateProfileV3 {
  const {version:_version,recovery:_recovery,storage,...settings}=original.settings;
  return linuxCreateProfileFrom({...original,schema:"pirate.community-linux-profile/3",settings:{...settings,version:3,
    mode:"create",target:{kind:"local-linux"},storage:{publicMedia:storage.publicMedia,privateData:storage.privateData}}});
}
export function createPlanFixture(profile=createProfileFixture()):LinuxPlan {
  const body:Omit<LinuxPlan,"digest">={id:"plan:create-v3",profileDigest:digestJson(profile),expiresAt:Date.now()+60000,
    backend:{target:{endpointRef:"local:create-v3",endpointIdentityDigest:"1".repeat(64),stateNamespace:"state:create-v3",
      deploymentId:profile.identity.deploymentId},release:{sourceHead:"a".repeat(40),sourceTree:"b".repeat(40),
      manifest:{relativePath:"release/manifest.json",sha256:"2".repeat(64)},selectedProfileDigest:digestJson(profile),
      requiredServices:["application","accounts","media","jobs"]}},profile,operatorPolicy:null,
    targetInspectionId:"inspection:create-v3",targetFingerprint:"1".repeat(64),namespaceProofId:profile.namespace.id,
    action:"create",changes:[],warnings:[],requirements:[],restoreInspectionId:null,restoreManifestDigest:null,
    restoreCiphertextDigest:null,predecessorOperationId:null,sessionPolicy:null};
  return planFrom({...body,digest:digestJson(body)});
}
export function createOperationFixture():LinuxOperation {
  return {id:"operation:create-v3",kind:"create",draftRevision:1,plan:createPlanFixture(),startedAt:Date.now()};
}
