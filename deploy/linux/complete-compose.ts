import assert from "node:assert/strict";
import type {InstalledTarget} from "./local-target-controller.ts";
/** Produce a versioned Compose document for the exact same installed resource
 * descriptors. It never pulls, creates a network, embeds an environment key
 * or promotes the diagnostic foundation into a complete image. */
export function completeCompose(target:InstalledTarget,projectName:string) {
 assert(/^[a-z][a-z0-9-]{0,62}$/.test(projectName),"explicit_compose_project_name_required");
 const services:Record<string,unknown>={},networks:Record<string,unknown>={};
 for(const spec of target.containers){
  assert(/^sha256:[a-f0-9]{64}$/.test(spec.imageId) && /^[a-f0-9]{64}$/.test(spec.network));
  assert(!services[spec.name] && /^[0-9]+:[0-9]+$/.test(spec.user));
  services[spec.name]={image:spec.imageId,pull_policy:"never",container_name:spec.name,hostname:spec.name,
   read_only:true,user:spec.user,cap_drop:["ALL"],security_opt:["no-new-privileges:true"],restart:"no",
   entrypoint:spec.argv,labels:{"io.pirate.installation":target.installationId,"io.pirate.resource":spec.key},
   volumes:spec.mounts.map(m=>({type:"bind",source:m.source,target:m.target,read_only:m.readOnly,
    bind:{create_host_path:false}})),
   ports:spec.ports.map(p=>({host_ip:p.ip,published:String(p.host),target:p.container,protocol:"tcp"})),
   networks:[spec.network]};
  networks[spec.network]={external:true,name:spec.network};
 }
 assert(Object.keys(services).length>0);
 return JSON.stringify({name:projectName,services,networks},null,2)+"\n";
}

