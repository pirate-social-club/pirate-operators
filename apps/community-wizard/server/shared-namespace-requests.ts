import {requireRepresentable,NAMESPACE_RESULT_MAX_BYTES} from "./linux-journal-capacity.ts";
import {namespaceChallengeFrom} from "./shared-namespace-challenge.ts";
import {randomUUID} from "node:crypto";
import {fields,requireLinux,natural,hash,reference} from "../../../packages/community-setup/shared-linux-profile.ts";
import {namespaceResultFrom} from "./shared-namespace-port.ts";
import type {LinuxContext} from "./linux-context.ts";
import type {NamespaceChallenge} from "./linux-contracts.ts";
export function sharedNamespaceRequests(ctx:LinuxContext) {
  const {change,current,editable,call,naming}=ctx;
  async function start(kind:"begin"|"complete",value?:unknown) {
    const before=ctx.read(), revision=before.revision;
    requireLinux(before.namespaceHistory.length<1000,"namespace_history_full","Preserve/export original namespace request evidence before any new proof attempt.");
    const input=kind==="complete"?fields(value,["challengeId","proof"]):null;
    const challengeId=input?hash(input.challengeId):null;
    if(input)requireLinux(before.namespaceChallenge?.id===challengeId,"namespace_challenge_changed","Use the retained original challenge.");
    const id=randomUUID();
    await change(s=>{current(s,revision);editable(s);requireLinux(s.draft,"settings_required","Save community settings before any namespace proof attempt.");requireLinux(s.namespaceHistory.length<1000,"namespace_history_full","Preserve/export original namespace request evidence before any new proof attempt.");if(input)requireLinux(s.namespaceChallenge?.id===challengeId,"namespace_challenge_changed","Use the retained original challenge.");requireLinux(s.draft.origin.length<=512,"namespace_origin_bound","Use a hosting origin within the explicit journal response budget before any proof attempt.");naming.assertWritable();s.namespaceRequest={id,kind,bindingRevision:revision,challengeId};s.plan=null;});
    // Body is transient; interruption retains only an original request marker.
    // No automatic begin/complete retry. Root's durable caller journal resolves it.
    const result=kind==="begin"?await call(()=>naming.begin(id)):await call(()=>naming.complete({requestId:id,challengeId:challengeId!,proof:input!.proof}));
    await finish(id,result);
  }
  async function finish(id:string,result:NamespaceChallenge|unknown) {
    requireRepresentable(result,NAMESPACE_RESULT_MAX_BYTES);
    const s=ctx.read();requireLinux(s.namespaceRequest?.id===id,"namespace_request_changed","Recover the original namespace request.");
    const pending=s.namespaceRequest, d=s.draft;
    requireLinux(d,"settings_required","Retain selected settings.");
    const challenge=pending.kind==="begin"?namespaceChallengeFrom(result):null;
    const proof=pending.kind==="complete"?namespaceResultFrom(result,d.namespace.tld):null;
    if(proof)requireLinux(proof.status==="verified","namespace_pending","Authority remains pending.");
    await change(currentState=>{
      current(currentState,pending.bindingRevision);
      requireLinux(currentState.namespaceRequest?.id===id,"namespace_request_changed","Do not replace an original proof attempt.");
      if(challenge)currentState.namespaceChallenge=challenge;
      if(proof)currentState.namespace=proof;
      currentState.namespaceHistory.push({requestId:id,kind:pending.kind,challengeId:pending.challengeId,bindingRevision:pending.bindingRevision,outcome:"completed",evidenceRef:challenge?.id ?? (proof?.status==="verified"?proof.id:"")});
      currentState.namespaceRequest=null;currentState.plan=null;
    });
  }
  return {
    namespaceBegin:()=>start("begin"),
    namespaceComplete:(value:unknown)=>start("complete",value),
    async namespaceRecover() {
      const pending=ctx.read().namespaceRequest;
      requireLinux(pending,"namespace_request_required","No namespace proof request needs recovery.");
      const result=await call(()=>naming.recover(pending.id));
      if(result.state==="pending")return;
      if(result.state==="completed"){await finish(pending.id,result.result);return;}
      requireLinux(result.state==="not-started","namespace_recovery_invalid","Retain the original namespace request until actual recovery evidence is available.");
      reference(result.evidenceRef);
      await change(s=>{requireLinux(s.namespaceRequest?.id===pending.id,"namespace_request_changed","Retain original proof request.");s.namespaceHistory.push({requestId:pending.id,kind:pending.kind,challengeId:pending.challengeId,bindingRevision:pending.bindingRevision,outcome:"not-started",evidenceRef:result.evidenceRef});s.namespaceRequest=null;});
    }
  };
}
