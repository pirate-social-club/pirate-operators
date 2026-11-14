// Controlled Root/Directory selection only. No real deployment, mapping approval,
// HNS proof, source reader, price/gas authority or compiled Directory acceptance.
import {createHash} from "node:crypto";
import {directoryInstanceId,sharedNamespaceId} from "../packages/community/shared-identity.ts";
import {RELEASE_POLICY,RELEASE_POLICY_HASH} from "../packages/community/manifest-core.ts";
import {namespaceDigest} from "../packages/community-names/namespace-registry-adapter.ts";
import type {SharedRegistrySource} from "../packages/community-names/namespace-registry-adapter.ts";
import type {LinuxDraftV2,DeploymentIdentity} from "../packages/community-setup/shared-linux-profile.ts";
import type {SharedInfrastructure} from "../packages/community-setup/shared-linux-infrastructure.ts";
import type {NamespaceAuthorityProof} from "../packages/community-names/namespace-import.ts";
import type {Hex} from "viem";
const h=(s:string)=>("0x"+createHash("sha256").update(s).digest("hex")) as Hex;
export function fixtureShared(d:LinuxDraftV2) {
  const communityKey=h("fixture-new-public-key:"+d.slug), installationId=h("fixture-explicit-directory-install:"+d.slug);
  const communityId=directoryInstanceId(31337,communityKey);
  const identity:DeploymentIdentity={deploymentId:"deployment:"+d.slug,communityId,resources:{
    application:"app:"+d.slug,database:"db:"+d.slug,privateData:"private:"+d.slug,jobs:"jobs:"+d.slug,
    ...(d.features.learning?{learning:"learning:"+d.slug}:{})}};
  const registrySource:SharedRegistrySource={schema:"pirate.shared-registry-source/1",protocolVersion:3,
    sourceCommit:"56d63ad2738e0e6816b6157dba7174198700f2fa",
    abiSha256:"e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802",
    chainId:31337,registry:("0x"+"11".repeat(20)) as Hex,runtimeCodeHash:h("fixture-registry-runtime"),
    deployment:{blockNumber:"1",blockHash:h("fixture-deploy-block"),transactionHash:h("fixture-deploy-tx")},
    constructor:{admin:("0x"+"33".repeat(20)) as Hex,paymentToken:("0x"+"44".repeat(20)) as Hex,treasury:("0x"+"55".repeat(20)) as Hex},
    compiler:{version:"0.8.30",evmVersion:"cancun",optimizer:true,optimizerRuns:200,bytecodeHash:"none",cborMetadata:false}};
  const sourceSha256=createHash("sha256").update(JSON.stringify(registrySource)).digest("hex");
  const binding={installationId,revision:1,communityId,hostingOrigin:d.origin,issuanceTld:d.namespace.tld,
    namespaceId:sharedNamespaceId(d.namespace.tld),sourceSha256,deploymentIdentityDigest:namespaceDigest(identity)};
  const directory={schema:"pirate.shared-directory/2" as const,chainId:31337 as const,directory:("0x"+"22".repeat(20)) as Hex,
    directoryCodeHash:h("fixture-directory-runtime"),deploymentBlock:"1",communityId,communityKey,installationId,
    hostingOrigin:d.origin,registry:registrySource.registry,registryCodeHash:registrySource.runtimeCodeHash,
    registrySourceCommit:registrySource.sourceCommit as "56d63ad2738e0e6816b6157dba7174198700f2fa",
    registryAbiSha256:("0x"+registrySource.abiSha256) as Hex,tld:d.namespace.tld,namespaceId:binding.namespaceId};
  const infrastructure:SharedInfrastructure={schema:"pirate.shared-infrastructure/1",directory,sourceSha256,registrySource,binding,
    mapping:{schema:"pirate.linux-installation-mapping/1",mappingId:"fixture-mapping:"+d.slug,linuxInstallationId:"fixture-installation:"+d.slug,
      directoryInstallationId:installationId,communityKey,communityId,deploymentIdentityDigest:binding.deploymentIdentityDigest,origin:"new-shared",
      originalProfileSha256:null,evidence:{relativePath:"fixture/mapping.json",sha256:h("fixture-mapping-evidence").slice(2)}},
    configuration:{schema:"pirate.community-config/2",chainId:31337,directory:directory.directory,communityId,registry:directory.registry,tld:d.namespace.tld,
      communityKey,installationId,namespaceId:binding.namespaceId,registryCodeHash:directory.registryCodeHash,registrySourceCommit:directory.registrySourceCommit,
      registryAbiSha256:directory.registryAbiSha256,configurationRevision:1,postsContract:("0x"+"66".repeat(20)) as Hex,
      controller:("0x"+"33".repeat(20)) as Hex,publisher:("0x"+"77".repeat(20)) as Hex,operatorPayments:("0x"+"00".repeat(20)) as Hex,
      learningRecords:("0x"+"00".repeat(20)) as Hex,app:{label:"app",tokenGeneration:"0",origin:d.origin,httpsAlias:null,hnsIngress:"none"},
      feed:{endpoint:d.origin+"/api/feed",signingKeyId:"fixture-feed"},policies:{admission:{version:RELEASE_POLICY,sha256:RELEASE_POLICY_HASH},moderationSigner:("0x"+"88".repeat(20)) as Hex},publisherRevocations:[]}};
  const proof:NamespaceAuthorityProof={id:h("fixture-binding-proof"),binding,authorityKind:"hns_owner",externalAuthorityId:h("fixture-hns-control"),
    evidenceDigest:h("fixture-authority-evidence"),onChainAuthorityRevision:"1",onChainPolicyRevision:"2",onChainScopeRevision:"3",expiresAt:2_000_000_060_000,
    purpose:"bind_community_namespace",memberIssuance:"separate_authorization_required"};
  return {identity,infrastructure,proof};
}
