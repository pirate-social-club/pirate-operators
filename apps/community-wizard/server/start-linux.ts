import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {linuxLaunchOptions,launchInstalledLinuxWizard} from "./linux-launch.ts";
export const linuxUsage="npm run start:linux -- --composition /private/installed-inputs.mjs --sha256 <exact-lowercase-sha256>";
async function main(){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==="--help"){console.log(linuxUsage);return;}
 const options=linuxLaunchOptions(args);
 // The one-time local pairing code must not go to captured background logs.
 if(!process.stdout.isTTY)throw Error("Use an interactive private operator terminal for pairing.");
 process.umask(0o077);
 const running=await launchInstalledLinuxWizard(options,resolve(dirname(fileURLToPath(import.meta.url)),"../dist"));
 console.log("Linux setup listener (application readiness is unverified): "+running.origin);
 console.log("Private one-time operator pairing code: "+running.pairingCode);
 console.log("For a remote browser, forward this exact loopback port over your existing authenticated SSH connection.");
 running.erasePairing();running.pairingCode="";
 let stopping=false;
 const stop=async()=>{
  if(stopping)return;stopping=true;
  try{await running.runtime.close();}
  catch{console.error("Original custody remains retained. Reconcile the same installation before restarting.");process.exitCode=1;}
 };
 process.once("SIGINT",()=>void stop());process.once("SIGTERM",()=>void stop());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void main().catch(()=>{console.error("Linux setup did not start. Check the private installed composition, exact source pin and required native/authentication inputs. No substitute backend is available.");process.exitCode=1;});
}
