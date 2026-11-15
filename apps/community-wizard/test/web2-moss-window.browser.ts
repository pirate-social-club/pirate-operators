// Boundary failures authored before the window transport: blocked/closed
// windows, foreign source or origin, wrong digest, replay and late callbacks
// must never nominate an account or submit proof. The only simulated boundary
// is normal SDK transport; signatures and the paired HTTP/D1/Anvil flow are real.
import {test,expect} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {hostedWizardFixture} from "../../../test/fixtures/web2-hosted-wizard.ts";
const signingOrigin="https://signing.fixture.example";

test("top-level HTTPS signing window binds source, origin, nonce and separate connection/signature outcomes",async({page,context},info)=>{
  test.setTimeout(120000);const previous=process.cwd();process.chdir(fileURLToPath(new URL("../../../",import.meta.url)));
  const f=await hostedWizardFixture({publishing:true,signingOrigin});
  try {
    await context.addCookies([{name:"wizard_fixture",value:"paired",url:f.origin}]);
    const penpal=await readFile("apps/web/node_modules/penpal/dist/penpal.mjs","utf8");
    await context.exposeBinding("signingFixtureProof",async(_,data:unknown)=>({status:"success",signature:await f.sign(data)}));
    await context.addInitScript(()=>{window.addEventListener("message",e=>{
      if(e.data?.protocol==="pirate.web2-moss-window/1"&&e.data?.kind==="request")
        (window as unknown as {fixtureRequest:unknown}).fixtureRequest=e.data;
    });});
    await context.route(signingOrigin+"/**",async route=>{
      const path=new URL(route.request().url()).pathname;
      const file=path==="/operator-signing" ? "moss-signing.html" : path.slice(1);
      if(!/^(moss-signing\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file))return route.fulfill({status:404});
      await route.fulfill({contentType:file.endsWith(".html")?"text/html":file.endsWith(".css")?"text/css":"text/javascript",headers:{
        "referrer-policy":"strict-origin","x-content-type-options":"nosniff","cache-control":"no-store","x-frame-options":"DENY","cross-origin-opener-policy":"unsafe-none",
        "content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com; frame-src https://*.megaeth.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "permissions-policy":'publickey-credentials-get=(self "https://account.megaeth.com"), publickey-credentials-create=(self "https://account.megaeth.com")',
      },body:await readFile("apps/community-wizard/dist/"+file)});
    });
    await context.route("https://foreign.fixture.example/**",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Foreign source</title>"}));
    await context.route("https://account.megaeth.com/**",async route=>{
      if(new URL(route.request().url()).pathname==="/fixture-penpal.mjs")return route.fulfill({contentType:"text/javascript",body:penpal});
      await route.fulfill({contentType:"text/html",body:`<!doctype html><script type="module">
        import {connect,WindowMessenger} from '/fixture-penpal.mjs';
        const account={status:'connected',network:'testnet',address:${JSON.stringify(f.prepareInput.controller)}};
        const c=connect({messenger:new WindowMessenger({remoteWindow:parent,allowedOrigins:[${JSON.stringify(signingOrigin)}]}),methods:{status:()=>account,connect:async()=>account,signData:({data})=>window.signingFixtureProof(data)}});
        const remote=await c.promise;await remote.ready();</script>`});
    });
    await page.goto(f.origin+"/?setup=linux-web2");
    const open=async(label:string)=>{const event=page.waitForEvent("popup");await page.getByRole("button",{name:label,exact:true}).click();return event;};
    let popup=await open("Connect MOSS");
    await expect(popup.getByRole("button",{name:"Connect MOSS",exact:true})).toBeEnabled();
    const original=await popup.evaluate(()=> (window as unknown as {fixtureRequest:unknown}).fixtureRequest);
    // Same window object, foreign origin: neither the account nor a stale
    // signature may be accepted. Closing restores an explicit retry.
    await popup.goto("https://foreign.fixture.example/");
    await popup.evaluate(({message,target,address})=>{window.opener.postMessage({...message as object,kind:"response",status:"connected",address,network:"testnet"},target);},{message:original,target:f.origin,address:f.prepareInput.controller});
    await expect(page.getByLabel("Owner wallet",{exact:true})).toHaveValue("");
    await popup.close();await expect(page.getByRole("alert")).toContainText(/cancelled|closed/);
    popup=await open("Connect MOSS");
    await expect(popup.getByRole("button",{name:"Connect MOSS",exact:true})).toBeEnabled();
    const current=await popup.evaluate(()=> (window as unknown as {fixtureRequest:unknown}).fixtureRequest);
    const foreignOpening=popup.waitForEvent("popup");
    await popup.evaluate(origin=>window.open(origin+"/operator-signing?openerOrigin="+encodeURIComponent("http://127.0.0.1:1")),signingOrigin);
    const foreign=await foreignOpening;
    await foreign.evaluate(({message,target,address})=>{window.opener.opener.postMessage({...message as object,kind:"response",status:"connected",address},target);},{message:current,target:f.origin,address:f.prepareInput.controller});
    await foreign.close();
    await popup.evaluate(({message,target,address})=>{window.opener.postMessage({...message as object,kind:"response",status:"connected",address},target);},{message:original,target:f.origin,address:f.prepareInput.controller});
    await expect(page.getByLabel("Owner wallet",{exact:true})).toHaveValue("");
    await expect(popup.getByRole("button",{name:"Connect MOSS",exact:true})).toBeEnabled();
    await popup.evaluate(({target,address})=>{const r=(window as unknown as {fixtureRequest:Record<string,unknown>}).fixtureRequest;
      window.opener.postMessage({...r,kind:"response",status:"connected",requestDigest:"0x"+"ab".repeat(32),address,network:"testnet"},target);},{target:f.origin,address:f.prepareInput.controller});
    await expect(page.getByRole("alert")).toContainText(/protocol|request/);
    popup=await open("Connect MOSS");await popup.getByRole("button",{name:"Connect MOSS",exact:true}).click();
    await expect(page.getByLabel("Owner wallet",{exact:true})).toHaveValue(f.prepareInput.controller);
    expect(f.broadcasts()).toBe(0);expect(await f.preparationCount()).toBe(0);
    // Exercise a real bounded timer without changing authorization time. This
    // test-only button uses the same public wallet port with a shorter deadline.
    const {build}=await import("esbuild");
    const compiled=await build({stdin:{contents:`import {createWeb2MossWindow} from './apps/community-wizard/src/web2-moss-window.ts';
      const wallet=createWeb2MossWindow({signingOrigin:${JSON.stringify(signingOrigin)},timeoutMs:1000});
      const button=document.createElement('button'),result=document.createElement('output');button.textContent='Timed connection';result.id='timed-result';
      button.onclick=()=>{void wallet.connect().then(()=>{result.textContent='unexpected account';}).catch(error=>{result.textContent=error.message;});};
      document.body.append(button,result);`,resolveDir:process.cwd(),sourcefile:"window-boundary-fixture.ts"},bundle:true,write:false,format:"esm",platform:"browser"});
    await page.route(f.origin+"/fixture-timeout.js",route=>route.fulfill({contentType:"text/javascript",body:compiled.outputFiles[0]!.text}));
    await page.addScriptTag({url:f.origin+"/fixture-timeout.js",type:"module"});
    const timed=page.waitForEvent("popup");await page.getByRole("button",{name:"Timed connection",exact:true}).click();const timedPopup=await timed;
    await expect(page.locator("#timed-result")).toHaveText("web2_wallet_window_timeout");expect(timedPopup.isClosed()).toBe(true);
    await expect(page.getByLabel("Owner wallet",{exact:true})).toHaveValue(f.prepareInput.controller);
    await page.screenshot({path:info.outputPath("https-window-connected.png"),fullPage:true});
    await info.attach("boundary-evidence.json",{body:JSON.stringify({controller:f.prepareInput.controller,foreignOriginRefused:true,foreignSourceRefused:true,oldNonceRefused:true,boundedTimeout:true,wrongDigestRefused:true,oldRequestUnchanged:true,effects:f.broadcasts(),scope:"controlled SDK transport; no real MOSS/passkeys"}),contentType:"application/json"});
  } finally {await f.close();process.chdir(previous);}
});
