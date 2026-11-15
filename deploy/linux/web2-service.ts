#!/usr/bin/env node
/** Explicit persistent host-service entrypoint. Closing the paired setup is
 * separate from stopping this service. No detach, systemd mutation or adoption. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readPrivateJSON } from "./installed-records.ts";
import { launchWeb2LocalInstallation, type Web2LocalInstallationConfiguration } from "./web2-local-installation.ts";

export async function runWeb2Service(configurationFile:string) {
  const cancellation=new AbortController();
  let session:Awaited<ReturnType<typeof launchWeb2LocalInstallation>>|undefined,shutdown:Promise<void>|undefined;
  const stop=()=>{
    cancellation.abort(Error("installed_service_shutdown"));
    if(session) shutdown??=session.shutdownService().catch(error=>{
      process.exitCode=1;
      process.stderr.write("Service custody remains held; inspect the retained original operation.\n");
      throw error;
    });
    void shutdown?.catch(()=>undefined);
  };
  process.once("SIGINT",stop); process.once("SIGTERM",stop);
  try {
    const config=await readPrivateJSON<Web2LocalInstallationConfiguration>(configurationFile);
    session=await launchWeb2LocalInstallation(config,cancellation.signal);
    if(cancellation.signal.aborted){stop();await shutdown;return;}
    // Private operator terminal only; never forwarded to a public HTTP endpoint.
    process.stdout.write("Open "+session.origin+"\nPrivate pairing code: "+session.pairingCode+"\n");
    // This foreground service is the persistent child owner after setup closes.
    await new Promise<void>(resolve=>cancellation.signal.addEventListener("abort",()=>resolve(),{once:true}));
    await shutdown;
  } finally {
    process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  assert(process.argv.length===3 && process.argv[2]?.startsWith("/"),"supply_private_web2_service_configuration");
  await runWeb2Service(process.argv[2]);
}
