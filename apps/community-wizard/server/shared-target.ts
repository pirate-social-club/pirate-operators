import {fields, identityFrom, requireLinux, type LinuxDraftV2} from "../../../packages/community-setup/shared-linux-profile.ts";
import {infrastructureFrom} from "../../../packages/community-setup/shared-linux-infrastructure.ts";
import type {TargetInspection} from "./linux-contracts.ts";
// Only a complete server-owned preparation may establish public identity before signing.
export function preparedSharedTargetFrom(value:unknown, settings:Pick<LinuxDraftV2,"target">):TargetInspection["prepared"] {
  if(value===null)return null;
  const p=fields(value,["identity","infrastructure","settings"]);
  const identity=identityFrom(p.identity);
  // Full settings are returned by actual preparation, not inferred from a hosting suffix.
  const draft=sharedSettings(p.settings);
  requireLinux(JSON.stringify(draft.target)===JSON.stringify(settings.target),"target_changed","Use the inspected target.");
  return {identity,infrastructure:infrastructureFrom(p.infrastructure,identity,draft),settings:draft};
}
import {linuxDraftFrom as sharedSettings} from "../../../packages/community-setup/shared-linux-profile.ts";
