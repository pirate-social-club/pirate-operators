import type {Hex} from "viem";
import {parseSharedProfileDocument, sharedProfileDocument, type SharedDirectoryProfile} from "../community/shared-directory.ts";
import {parseConfiguration, isSharedConfiguration, type SharedCommunityConfig, type ConfigurationState} from "../community/config-manifest.ts";
import {validateSharedConfig} from "../community/shared-config-manifest.ts";
import {namespaceBinding, type NamespaceBinding} from "../community-names/namespace-import.ts";
import {selectedSource, type SharedRegistrySource} from "../community-names/namespace-registry-adapter.ts";
import {fields, record, text, reference, hash, natural, requireLinux} from "./linux-input.ts";
import type {DeploymentIdentity} from "./linux-profile.ts";
import type {LinuxDraftV2} from "./shared-linux-draft.ts";
export interface InstallationMapping {
  schema: "pirate.linux-installation-mapping/1";
  mappingId: string; linuxInstallationId: string; directoryInstallationId: Hex;
  communityKey: Hex; communityId: Hex; deploymentIdentityDigest: Hex;
  origin: "new-shared" | "retained-shared"; originalProfileSha256: string | null;
  evidence: {relativePath:string;sha256:string};
}
export interface SharedInfrastructure {
  schema: "pirate.shared-infrastructure/1";
  directory: ReturnType<typeof sharedProfileDocument>;
  configuration: SharedCommunityConfig;
  registrySource: SharedRegistrySource;
  sourceSha256: string;
  mapping: InstallationMapping;
  binding: NamespaceBinding;
}
export function rawSha(value: unknown): string {
  requireLinux(typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && value !== "0".repeat(64), "shared_digest", "Use the exact selected source/evidence digest.");return value;
}
export function mappingFrom(value: unknown): InstallationMapping {
  const m=fields(value,["schema","mappingId","linuxInstallationId","directoryInstallationId","communityKey","communityId","deploymentIdentityDigest","origin","originalProfileSha256","evidence"]);
  requireLinux(m.schema === "pirate.linux-installation-mapping/1" && (m.origin === "new-shared" || m.origin === "retained-shared"), "legacy_cutover_required", "A V1 installation needs its explicit inventory/mapping/cutover migration; never hash or replace its identity.");
  const e=fields(m.evidence,["relativePath","sha256"]), path=text(e.relativePath,512);
  requireLinux(!path.startsWith("/") && path.split("/").every(v=>/^[A-Za-z0-9_.-]+$/.test(v) && v!=="." && v!==".."),"mapping_evidence","Retain the real mapping ledger evidence.");
  requireLinux(m.origin !== "retained-shared" || m.originalProfileSha256 !== null,"mapping_original_required","Retain the original import/restore profile digest.");
  return {schema:"pirate.linux-installation-mapping/1",mappingId:reference(m.mappingId),linuxInstallationId:reference(m.linuxInstallationId),
    directoryInstallationId:hash(m.directoryInstallationId) as Hex,communityKey:hash(m.communityKey) as Hex,communityId:hash(m.communityId) as Hex,
    deploymentIdentityDigest:hash(m.deploymentIdentityDigest) as Hex,origin:m.origin,
    originalProfileSha256:m.originalProfileSha256===null?null:rawSha(m.originalProfileSha256),evidence:{relativePath:path,sha256:rawSha(e.sha256)}};
}
export function infrastructureFrom(value: unknown, identity: DeploymentIdentity, settings: LinuxDraftV2): SharedInfrastructure {
  const s=fields(value,["schema","directory","configuration","registrySource","sourceSha256","mapping","binding"]);
  requireLinux(s.schema === "pirate.shared-infrastructure/1","shared_selection_required","Select the shared source explicitly.");
  const p=parseSharedProfileDocument(s.directory), mapping=mappingFrom(s.mapping), sourceSha256=rawSha(s.sourceSha256);
  const registrySource=selectedSource(s.registrySource as SharedRegistrySource,sourceSha256);
  const binding=namespaceBinding(s.binding as NamespaceBinding);
  const config=parseConfiguration(s.configuration);
  requireLinux(isSharedConfiguration(config),"shared_config_required","V1 configuration is not shared configuration.");
  requireLinux(config.chainId===p.chainId && config.directory===p.directory && config.communityId===p.communityId &&
    config.communityKey===p.communityKey && config.installationId===p.installationId && config.namespaceId===p.namespaceId &&
    config.registry===p.registry && config.registryCodeHash===p.registryCodeHash && config.registrySourceCommit===p.registrySourceCommit &&
    config.registryAbiSha256===p.registryAbiSha256 && config.tld===p.tld && config.app.origin===p.hostingOrigin,
    "shared_config_binding","Retain exact Directory/configuration selection.");
  requireLinux(registrySource.chainId===p.chainId && registrySource.registry===p.registry && registrySource.runtimeCodeHash===p.registryCodeHash &&
    registrySource.sourceCommit===p.registrySourceCommit && ("0x"+registrySource.abiSha256)===p.registryAbiSha256,
    "shared_registry_source","Use the exact admitted registry source; ABI strings are not deployment admission.");
  requireLinux(identity.communityId===p.communityId && mapping.communityId===p.communityId && mapping.communityKey===p.communityKey &&
    mapping.directoryInstallationId===p.installationId && binding.installationId===p.installationId && binding.communityId===p.communityId &&
    binding.namespaceId===p.namespaceId && binding.sourceSha256===sourceSha256 && binding.deploymentIdentityDigest===mapping.deploymentIdentityDigest &&
    binding.hostingOrigin===p.hostingOrigin && binding.issuanceTld===p.tld && settings.origin===p.hostingOrigin && settings.namespace.tld===p.tld,
    "shared_installation_binding","Use the recorded original installation, portable key, origin and namespace. A saved string is not a migration.");
  return {schema:"pirate.shared-infrastructure/1",directory:sharedProfileDocument(p),configuration:config,
    registrySource:structuredClone(registrySource),sourceSha256,mapping,binding};
}
// Root supplies reconstructed authenticated history from the real core reader/cache.
// Never construct lastRevision-1 or empty revocations from a saved current document.
export function validateProfileConfiguration(infrastructure: SharedInfrastructure, state: ConfigurationState, publicationBlock: bigint) {
  requireLinux(state && state.publishers instanceof Set && state.revocations instanceof Set && typeof publicationBlock==="bigint", "configuration_history_required", "Use the authenticated Directory reader history/cache.");
  return validateSharedConfig(infrastructure.configuration,parseSharedProfileDocument(infrastructure.directory),state,publicationBlock);
}
export function sameSharedInstallation(a: SharedInfrastructure,b:SharedInfrastructure) {
  const x=parseSharedProfileDocument(a.directory), y=parseSharedProfileDocument(b.directory);
  return x.communityKey===y.communityKey && x.communityId===y.communityId && x.installationId===y.installationId &&
    x.directory===y.directory && x.directoryCodeHash===y.directoryCodeHash && x.chainId===y.chainId &&
    x.registry===y.registry && x.registryCodeHash===y.registryCodeHash && a.sourceSha256===b.sourceSha256 &&
    x.namespaceId===y.namespaceId && x.tld===y.tld && x.hostingOrigin===y.hostingOrigin &&
    a.mapping.mappingId===b.mapping.mappingId && a.mapping.linuxInstallationId===b.mapping.linuxInstallationId &&
    a.mapping.deploymentIdentityDigest===b.mapping.deploymentIdentityDigest;
}
