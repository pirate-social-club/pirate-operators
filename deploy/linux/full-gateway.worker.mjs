export default {
 async fetch(request,env){
  const initialized=await env.STARTUP.fetch("http://private/ready");
  if(initialized.status!==200)return new Response(null,{status:503});
  const path=new URL(request.url).pathname;
  if(path.startsWith("/_operator/readback/")){
   const key=request.headers.get("X-Pirate-Readback-Key");
   if(!key || !/^[a-f0-9]{64}$/.test(key) || env.READBACK_KEY.length!==64)return new Response(null,{status:404});
   const encoder=new TextEncoder(),a=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(key))),
     b=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(env.READBACK_KEY)));
   let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
   if(mismatch!==0)return new Response(null,{status:404});
   return env.OBSERVER.fetch(request);
  }
  return env.APPLICATION.fetch(request);
 }
};

