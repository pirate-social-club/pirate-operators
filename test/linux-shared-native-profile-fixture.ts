// Adapted public codec data from exact W6 shared fixture; provenance in input matrix.
// Not an accepted backend, HNS proof, RPC or host. Installation IDs are
// independent explicit literals, never hashed/transformed from a slug/TLD.
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
  const communityKey=("0x"+"d".repeat(64)) as Hex, installationId=("0x"+"e".repeat(64)) as Hex;
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
    mapping:{schema:"pirate.linux-installation-mapping/1",mappingId:"fixture-mapping:"+d.slug,linuxInstallationId:"fixture-explicit-linux-installation",
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

export const fixtureDraft = (slug = "fixture-community"): LinuxDraftV2 => ({
  version: 2,
  infrastructure: "pirate.shared-directory/2",
  mode: "create",
  name: "Fixture community",
  slug,
  origin: `https://${slug}.example`,
  target: { kind: "local-linux" },
  namespace: { tld: "fixture" },
  features: {
    learning: false,
    karaoke: false,
    media: false,
    dance: false,
    telegram: false,
  },
  services: {
    publicationProfile: "publication:verified",
    learningProfile: null,
  },
  storage: {
    publicMedia: { version: 1, role: "public-ipfs", provider: "filebase-ipfs" },
    privateData: { provider: "local-volume" },
    backup: {
      version: 1,
      role: "backup",
      provider: "filebase-private",
      bucket: "fixture-recovery",
      endpoint: "https://s3.filebase.io",
      region: "auto",
      forcePathStyle: false,
    },
  },
  limits: {
    speechDaily: 100,
    websiteReserved: 50,
    perAccountDaily: 10,
    monthlyUsdCents: 1000,
  },
  recovery: { sessionPolicy: "revoke-existing" },
});

import {linuxProfileFrom,type LinuxCommunityProfileV2} from "../packages/community-setup/shared-linux-profile.ts";
export function fixtureProfile(settings=fixtureDraft("fixture-community")):LinuxCommunityProfileV2{
 const s=fixtureShared(settings);
 return linuxProfileFrom({schema:"pirate.community-linux-profile/2",settings,identity:s.identity,infrastructure:s.infrastructure,
  namespace:s.proof,runtime:{sourceDigest:"0x"+"1".repeat(64),artifactDigest:"0x"+"2".repeat(64),
   recipe:"public-codec-fixture",migrations:{"0001_setup.sql": "0x7c316355896c3df6df63cc21f2bd591c7c55bba7797bd5304aa36c8ae6f0a198"}},learning:null});
}
