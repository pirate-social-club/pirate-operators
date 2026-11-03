export function page(csrf: string, nonce: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Very credential probe · Pirate</title>
<style>
body{font:17px/1.55 system-ui,sans-serif;background:#101c25;color:#ecf3f5;margin:0;padding:32px 20px}
main{max-width:780px;margin:auto}h1{font-size:32px;line-height:1.2}h2{font-size:21px}
.muted{color:#afc6cf}.box{border:1px solid #40545e;border-radius:16px;padding:24px;margin:24px 0}
button,a{font:inherit}button{background:#a5f2d5;color:#102820;border:0;border-radius:8px;padding:10px 16px;margin:0 8px 8px 0;cursor:pointer}
button:disabled{opacity:.4;cursor:default}a{color:#a5f2d5}#qr{max-width:280px}#qr svg{width:100%;height:auto}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#error{color:#ffc3ab}li{margin:8px 0}
</style><main>
<p class="muted">PIRATE / IDENTITY EXPERIMENT</p><h1>Test one Very credential across four requests</h1>
<p>This research tool issues no rewards and moves no funds. Use the same existing Very enrollment for every request. Do not create another enrollment for this test.</p>
<p>Participant A and B are labels with fresh challenges, not connected wallets. The result tests a credential’s behavior, not unique humanity.</p>
<ol><li>Participant A in scope A.</li><li>Repeat A in scope A with a new challenge.</li><li>Participant B in scope A with another challenge.</li><li>Participant A in a different scope B.</li></ol>
<section class="box"><p id="mode" class="muted"></p><h2 id="next">Loading…</h2>
<p id="status" role="status"></p><p id="error" role="alert"></p>
<button id="start" disabled>Start Very request</button><button id="reset">Clear and restart</button>
<div id="qr"></div><p><a id="launch" hidden>Open in Very on this device</a></p>
<p class="muted">Each request expires after five minutes. The QR contains a temporary decryption key: scan it privately and do not share it. Closing this process clears its in-memory comparisons.</p></section>
<section class="box"><h2>Redacted observations</h2><pre id="report"></pre>
<button id="download" disabled>Download completed report</button>
<p class="muted">Reports contain comparison results, not proofs, credential identifiers, bridge handles or encryption keys. A fixture report is not live provider evidence.</p></section>
</main><script nonce="${nonce}">
const csrf=${JSON.stringify(csrf)};
const el=id=>document.getElementById(id);
let report, waiting=false, requestBusy=false;
async function call(path){
 if(requestBusy)return;
 requestBusy=true;
 try{
  const response=await fetch(path,{method:'POST',headers:{'X-Probe-CSRF':csrf}});
  if(!response.ok)throw new Error();
  const v=await response.json();report=v.report;waiting=v.state==='waiting';
  el('mode').textContent=v.report.mode==='live'?'LIVE PROVIDER MODE':'FIXTURE MODE — simulated provider';
  el('next').textContent=v.next||'Four requests complete';
  el('status').textContent='State: '+v.state;
  el('error').textContent=v.error||'';
  el('start').disabled=v.busy||['waiting','verifying','starting','complete'].includes(v.state);
  el('start').textContent=v.report.mode==='live'?'Start live Very request':'Start fixture request';
  el('qr').innerHTML=v.qr||'';
  el('launch').hidden=!v.launch;if(v.launch)el('launch').href=v.launch;else el('launch').removeAttribute('href');
  el('report').textContent=JSON.stringify(report,null,2);el('download').disabled=!report.complete;
 }catch{waiting=false;el('error').textContent='Local probe unavailable. Reload or restart it.';el('qr').replaceChildren();el('launch').hidden=true;}
 finally{requestBusy=false;}
}
el('start').onclick=()=>call('/start');el('reset').onclick=()=>call('/reset');
el('download').onclick=()=>{if(!report?.complete)return;const u=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\\n'],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='very-probe-'+report.mode+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
setInterval(()=>{if(waiting)call('/poll');},2500);call('/state');
</script></html>`;
}
