// Selected operation/destination is separate from the signed original profile.
// This helper grants no new configuration, namespace, resource or session right.
import type {OriginalLinuxDraft} from "./linux-create-profile.ts";
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)
 ?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x);
export function sameOperationalSelection(original:OriginalLinuxDraft,selected:OriginalLinuxDraft,sessionPolicy:string|null){
 if(original.version === 3 || selected.version === 3)return original.version === 3 && selected.version === 3 && sessionPolicy === null && stable(original) === stable(selected);
 if(selected.recovery.sessionPolicy!==sessionPolicy)return false;
 if(selected.mode==="create")return stable(original)===stable(selected);
 // The authentic inspection/capabilities must separately authorize this
 // restore policy. Only destination, operation and explicit policy differ.
 return stable({...original,mode:selected.mode,target:selected.target,
  recovery:{...original.recovery,sessionPolicy}})===stable(selected);
}
export function operationActionMatches(kind:OriginalLinuxDraft["mode"],action:string){
 return kind==="restore"?action==="restore":kind==="import"?
  action==="adopt"||action==="upgrade":action==="create"||action==="upgrade";
}
