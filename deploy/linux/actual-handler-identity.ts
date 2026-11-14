export interface ActualHandlerIdentity {
 installationId:string;requestId:string;generation:number;profileDigest:string;outcome:string;
}
export function actualHandlerIdentity(body:unknown,expected:ActualHandlerIdentity,pointers:Record<keyof ActualHandlerIdentity,string>){
 const observed:Record<string,unknown>={};
 for(const [key,wanted] of Object.entries(expected)){
  const selected=pointers?.[key as keyof ActualHandlerIdentity];
  if(typeof selected!=="string" || !selected.startsWith("/"))throw Error("actual_handler_identity_selector_missing");
  let value:unknown=body;
  for(const part of selected.slice(1).split("/")){
   if(value===null || typeof value!=="object" || !Object.hasOwn(value,part))throw Error("actual_handler_identity_missing");
   value=(value as Record<string,unknown>)[part];
  }
  if(value!==wanted)throw Error("actual_handler_identity_mismatch");observed[key]=value;
 }
 return observed;
}
