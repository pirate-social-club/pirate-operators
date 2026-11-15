import {fields,text,reference,natural,requireLinux} from "./linux-input.ts";
// Root/Storage supplies actual service-contract and enforcement readbacks.
// This is not a provider-cap, grant, fee or funding implementation.
// A required zero quote is policy, not an actual per-name quote. The member
// service must read real reservations/overrides/current quote before a claim.
export interface OperatorPolicyView {
  schema:"pirate.operator-policy-view/1";
  speech:null|{contractId:string;unitLabel:string;definition:string};
  providerBudget:{proposalUsdCents:number;enforcement:"unverified"|"provider-cap"|"operator-stop";coveredServices:string[];excludedServices:string[];evidenceRef:string|null};
  freeNames:null|{minimumCharacters:8;requiredEffectiveQuote:"0";maxCost:"0";paidFallback:false;approval:"none";termSeconds:31536000;renewal:string;gasFunding:string;evidenceRef:string};
}
export function operatorPolicyFrom(value:unknown):OperatorPolicyView|null {
  if(value===null)return null;
  const p=fields(value,["schema","speech","providerBudget","freeNames"]);
  requireLinux(p.schema==="pirate.operator-policy-view/1","operator_policy_version","Use the selected actual policy readback.");
  let speech:OperatorPolicyView["speech"]=null;
  if(p.speech!==null){const s=fields(p.speech,["contractId","unitLabel","definition"]);speech={contractId:reference(s.contractId),unitLabel:text(s.unitLabel,100),definition:text(s.definition,800)};}
  const b=fields(p.providerBudget,["proposalUsdCents","enforcement","coveredServices","excludedServices","evidenceRef"]);
  const services=(v:unknown)=>{requireLinux(Array.isArray(v)&&v.length<=30&&v.every(s=>typeof s==="string"&&s.length>0&&s.length<=100),"provider_scope","Show actual covered and excluded services.");return v as string[];};
  requireLinux(["unverified","provider-cap","operator-stop"].includes(String(b.enforcement)) && (b.enforcement==="unverified"||b.evidenceRef!==null),"provider_enforcement","A proposal is not provider-enforced. Require actual cap or alert/stop evidence.");
  let freeNames:OperatorPolicyView["freeNames"]=null;
  if(p.freeNames!==null){
    const n=fields(p.freeNames,["minimumCharacters","requiredEffectiveQuote","maxCost","paidFallback","approval","termSeconds","renewal","gasFunding","evidenceRef"]);
    requireLinux(n.minimumCharacters===8 && n.requiredEffectiveQuote==="0" && n.maxCost==="0" && n.paidFallback===false && n.approval==="none" && n.termSeconds===31536000,"free_name_policy","Use actual >=8 ordinary-label zero-effective-price policy. Gas and renewals remain separate; no paid fallback.");
    freeNames={minimumCharacters:8,requiredEffectiveQuote:"0",maxCost:"0",paidFallback:false,approval:"none",termSeconds:31536000,renewal:text(n.renewal,500),gasFunding:text(n.gasFunding,500),evidenceRef:reference(n.evidenceRef)};
  }
  return {schema:"pirate.operator-policy-view/1",speech,freeNames,providerBudget:{proposalUsdCents:natural(b.proposalUsdCents,100000000),enforcement:b.enforcement as OperatorPolicyView["providerBudget"]["enforcement"],coveredServices:services(b.coveredServices),excludedServices:services(b.excludedServices),evidenceRef:b.evidenceRef===null?null:reference(b.evidenceRef)}};
}
