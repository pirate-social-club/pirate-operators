#!/usr/bin/env node
// Installed entrypoint, deliberately unbundled and executed through pinned tsx.
import assert from "node:assert/strict";
import {readPrivateJSON} from "./installed-records.ts";
import {launchLocalInstallation,type LocalInstallationConfiguration} from "./local-installation.ts";

const args=process.argv.slice(2);
assert(args.length===1 && args[0]?.startsWith("/"),"supply_private_installation_configuration_path");
const config=await readPrivateJSON<LocalInstallationConfiguration>(args[0]!);
const session=await launchLocalInstallation(config);
// This is the operator's private terminal, never a public HTTP/log endpoint.
process.stdout.write("Open "+session.origin+"\nPrivate pairing code: "+session.pairingCode+"\n");
let closing=false;
async function close(){
  if(closing)return;closing=true;
  try{await session.runtime.close();}
  catch(error){process.exitCode=1;process.stderr.write("Installation custody remains held; inspect the retained operation before retry.\n");}
}
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void close();});
