import {isSharedConfiguration} from "../../../packages/community/config-manifest.ts";
import {parseSharedProfileDocument,sharedProfileDocument} from "../../../packages/community/shared-directory.ts";
import {parseConfiguration} from "../../../packages/community/config-manifest.ts";
import {fields,reference,hash,requireLinux,type LinuxCommunityProfileV2} from "../../../packages/community-setup/shared-linux-profile.ts";
import {canonical} from "./linux-journal.ts";
// This checks a required actual reader result's context; no RPC/cache authority
// is synthesized here. Root's postReadback must invoke the qualified core reader.
export function requireSharedReadback(value:unknown,expected:LinuxCommunityProfileV2) {
  const r=fields(value,["directory","configuration","evidenceRef","blockNumber","blockHash"]);
  const p=sharedProfileDocument(parseSharedProfileDocument(r.directory)), config=parseConfiguration(r.configuration);
  requireLinux(isSharedConfiguration(config) && canonical(p)===canonical(expected.infrastructure.directory) &&
    canonical(config)===canonical(expected.infrastructure.configuration),"shared_configuration_readback","Actual shared Directory/configuration does not match the retained plan.");
  reference(r.evidenceRef);hash(r.blockHash);
  requireLinux(typeof r.blockNumber==="string" && /^(0|[1-9][0-9]*)$/.test(r.blockNumber),"shared_configuration_readback","Retain the actual canonical reader checkpoint.");
}
