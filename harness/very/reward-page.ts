export function rewardPage(csrf: string, nonce: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Very reward registration test</title><style>
body{font:16px/1.55 system-ui;background:#111827;color:#e5e7eb;margin:0;padding:24px}main{max-width:720px;margin:auto}h1{font-size:28px}button{padding:12px 18px;font:inherit;border:0;border-radius:7px;background:#a7f3d0;color:#10251d;cursor:pointer}button:disabled{opacity:.5;cursor:wait}#qr{background:white;max-width:300px;margin:20px 0}#qr svg{display:block;width:100%;height:auto}#error{color:#fecaca}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}a{color:#a7f3d0}.note{border-left:3px solid #fbbf24;padding-left:15px}</style>
<main><p>BASE SEPOLIA · TEST TOKENS</p><h1>Very reward registration</h1>
<p>This tests one existing Very enrollment with a dedicated test wallet managed by the harness. It does not connect your personal wallet.</p>
<p class="note">Completing the scan submits a test registration. Its scoped reward identifier and test-wallet address will be public on Base Sepolia. Fresh scans, unique humanity and app-origin binding are not established. Use your existing enrollment.</p>
<p id="state">Loading…</p><p id="error" role="alert"></p><button id="start" disabled>Start Very request</button>
<div id="qr" hidden></div><p><a id="launch" hidden>Open Very on this device</a></p>
<p>The request expires after five minutes. The QR contains a temporary decryption key: scan privately and do not share it. This page closes after 30 minutes.</p>
<pre id="report"></pre></main>
<script nonce="${nonce}">
const csrf=${JSON.stringify(csrf)}; let busy=false,timer;
const el=id=>document.getElementById(id);
async function update(path='/state'){
 if(busy)return;busy=true;clearTimeout(timer);
 try{
  const response=await fetch(path,{method:'POST',headers:{'X-Probe-Csrf':csrf},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('request');const view=await response.json();
  el('state').textContent='State: '+view.state;el('error').textContent=view.error||'';
  el('start').disabled=view.busy||!['ready','failed','expired'].includes(view.state);
  el('qr').hidden=!view.qr;el('qr').innerHTML=view.qr||'';
  el('launch').hidden=!view.launch;if(view.launch)el('launch').href=view.launch;
  el('report').textContent=JSON.stringify(view.report,null,2);
  if(['starting','waiting','verifying','registration_unknown'].includes(view.state))timer=setTimeout(()=>update('/poll'),1500);
 }catch{el('error').textContent='Connection interrupted. Retrying without clearing the request.';timer=setTimeout(()=>update('/poll'),1500);}
 finally{busy=false;}
}
el('start').addEventListener('click',()=>update('/start'));update();
</script></html>`;
}
