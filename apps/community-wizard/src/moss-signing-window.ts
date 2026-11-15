import {createWeb2Wallet} from "./web2-wallet.ts";
import {MOSS_WINDOW_PROTOCOL,checkedMossWindowRequest,loopbackSigningOpener,mossSigningOrigin,type MossWindowRequest,type MossWindowResponse} from "./web2-moss-window.ts";
const status=document.querySelector<HTMLElement>("#status")!,review=document.querySelector<HTMLElement>("#review")!,approve=document.querySelector<HTMLButtonElement>("#approve")!,cancel=document.querySelector<HTMLButtonElement>("#cancel")!;
let openerOrigin:string,signingOrigin:string,opener:Window|null,request:MossWindowRequest|null=null,finished=false,busy=false;
function unavailable(){finished=true;status.textContent="This signing window is unavailable. Return to the original paired Wizard and retry.";approve.disabled=true;cancel.disabled=true;}
try {
  const url=new URL(window.location.href);
  if(window.top!==window.self||url.hash||[...url.searchParams.keys()].join(",")!=="openerOrigin")throw Error("invalid window");
  openerOrigin=loopbackSigningOpener(url.searchParams.get("openerOrigin")!);signingOrigin=mossSigningOrigin(url.origin);opener=window.opener;
  if(!opener||opener.closed)throw Error("missing opener");
  const reply=(result:({status:"connected";address:`0x${string}`}|{status:"signed";address:`0x${string}`;signature:`0x${string}`}|{status:"cancelled"}|{status:"error";code:string}))=>{
    if(finished||!request)return;finished=true;approve.disabled=true;cancel.disabled=true;
    const response:MossWindowResponse={protocol:MOSS_WINDOW_PROTOCOL,kind:"response",channel:request.channel,requestDigest:request.requestDigest,purpose:request.purpose,network:"testnet",...result};
    opener!.postMessage(response,openerOrigin);status.textContent="Result returned to the paired Wizard. You may close this window.";
  };
  const timer=setTimeout(()=>{if(request)reply({status:"error",code:"web2_wallet_window_timeout"});else unavailable();},180000);
  window.addEventListener("message",event=>{
    if(finished||request||event.source!==opener||event.origin!==openerOrigin)return;
    try {
      request=checkedMossWindowRequest(event.data,openerOrigin,signingOrigin);
      status.textContent=request.purpose==="connect"?"Connect your human controller on testnet.":"Review this exact retained typed request. This is separate from login and song terms.";
      review.textContent=JSON.stringify({purpose:request.purpose,expectedController:request.expectedController,requestDigest:request.requestDigest,data:request.data},null,2);
      approve.textContent=request.purpose==="connect"?"Connect MOSS":"Review and sign";approve.disabled=false;cancel.disabled=false;
    } catch {unavailable();}
  });
  cancel.onclick=()=>{clearTimeout(timer);reply({status:"cancelled"});};
  approve.onclick=async()=>{
    if(busy||finished||!request)return;busy=true;approve.disabled=true;
    const captured=structuredClone(request),wallet=createWeb2Wallet();
    try {
      if(captured.purpose==="connect") {
        const before=await wallet.connect(),after=await wallet.connect();
        if(before.address!==after.address||before.network!=="testnet"||after.network!=="testnet")throw Error("web2_wallet_account_changed");
        reply({status:"connected",address:after.address});
      } else {
        const result=await wallet.signTypedData({expectedController:captured.expectedController!,requestDigest:captured.requestDigest,data:captured.data as Parameters<typeof wallet.signTypedData>[0]["data"]});
        if(result.status==="success")reply({status:"signed",signature:result.signature,address:captured.expectedController!});
        else reply(result);
      }
    } catch(error){reply({status:"error",code:error instanceof Error&&/^web2_wallet_[a-z_]{1,80}$/.test(error.message)?error.message:"web2_wallet_unavailable"});}
    finally{clearTimeout(timer);busy=false;}
  };
  opener.postMessage({protocol:MOSS_WINDOW_PROTOCOL,kind:"ready"},openerOrigin);
} catch {unavailable();}
