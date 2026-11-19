// Current Root shell, not the historical whole-file wizard entry.
import {createSignal,onSettled,Show} from "solid-js";
import type {JSX} from "@solidjs/web";
import {LinuxWizard} from "./linux-wizard.tsx";
import {Web2Wizard} from "./web2-wizard.tsx";
import {linuxRequest,type LinuxSnapshot} from "./linux-api.ts";
export function WizardEntry(props:{cloudflare:()=>JSX.Element}){
 const [view,setView]=createSignal<LinuxSnapshot>();
 const [error,setError]=createSignal("");
 const [mode,setMode]=createSignal<"linux"|"cloudflare"|"linux-web2">();
 onSettled(()=>{void(async()=>{
  const requested=new URL(window.location.href).searchParams.get("setup");
  // Authentication/transport errors are not an unavailable capability and
  // never silently select another application/authentication flow.
  const state=await linuxRequest();setView(state);
  setMode(requested==="linux"||requested==="cloudflare"||requested==="linux-web2"?requested:state.web2Available?"linux-web2":state.available?"linux":"cloudflare");
 })().catch(e=>setError(e instanceof Error?e.message:"Reconnect to the original authenticated setup runner."));});
 return <>
  <nav class="wizard-modes" aria-label="Hosting setup">
   <a href="/?setup=linux-web2" aria-current={mode()==="linux-web2"?"page":undefined}
    onClick={event=>{
     if(mode()==="linux-web2"&&event.button===0&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey)
      event.preventDefault();
    }}>HTTPS community</a>
   <a href="/?setup=linux" aria-current={mode()==="linux"?"page":undefined}>Linux / existing VPS</a>
   <a href="/?setup=cloudflare" aria-current={mode()==="cloudflare"?"page":undefined}>Cloudflare setup</a>
  </nav>
  <Show when={error()}><div class="wizard-entry-message alert" role="alert">{error()} Reload the original paired runner to recover.</div></Show>
  <Show when={!error()&&mode()} fallback={!error()?<p class="wizard-entry-message" role="status">Connecting to the setup runner…</p>:undefined}>
   <Show when={mode()==="linux-web2"} fallback={<Show when={mode()==="linux"} fallback={
    <Show when={view()?.legacyAvailable} fallback={<p class="wizard-entry-message" role="status">This authenticated Linux runner does not mount Cloudflare setup. Its existing operator command remains separate.</p>}>
     {props.cloudflare()}
    </Show>}>
    <div class="linux-setup"><LinuxWizard /></div>
   </Show>}><Web2Wizard /></Show>
  </Show>
 </>;
}
