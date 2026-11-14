// Unsigned installed launch selection. This grants no signed profile authority.
import {isAbsolute,normalize} from "node:path";
import {fields,reference,natural,requireLinux} from "../../packages/community-setup/linux-input.ts";
export interface LinuxCreateRuntimeProfile {
  schema:"pirate.linux-create-runtime/1";
  installationId:string;
  backendConfigurationFile:string;
  wizardDirectory:string;
  pairingNonceDirectory:string;
  frontPort:number;
  innerPort:number;
}
export function linuxCreateRuntimeProfileFrom(value:unknown):LinuxCreateRuntimeProfile {
  const p=fields(value,["schema","installationId","backendConfigurationFile","wizardDirectory","pairingNonceDirectory","frontPort","innerPort"]);
  requireLinux(p.schema === "pirate.linux-create-runtime/1","create_runtime_schema","Select the explicit installed local create runtime.");
  const path=(v:unknown)=>{
    requireLinux(typeof v === "string" && v.length<=4096 && !/[\x00-\x1f\x7f]/.test(v) &&
      isAbsolute(v) && normalize(v)===v && v!=="/","create_runtime_path","Supply an exact owned installed path.");
    return v;
  };
  const frontPort=natural(p.frontPort,65535),innerPort=natural(p.innerPort,65535);
  requireLinux(frontPort>0 && innerPort>0 && frontPort!==innerPort,"create_runtime_ports","Use distinct explicit loopback ports.");
  return {schema:"pirate.linux-create-runtime/1",installationId:reference(p.installationId),
    backendConfigurationFile:path(p.backendConfigurationFile),wizardDirectory:path(p.wizardDirectory),
    pairingNonceDirectory:path(p.pairingNonceDirectory),frontPort,innerPort};
}
