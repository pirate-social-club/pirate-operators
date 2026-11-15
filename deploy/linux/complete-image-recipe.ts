import assert from "node:assert/strict";
/** Image recipe only. Root separately admits the real pinned base/context,
 * build and resulting image digest; this function performs no Docker action. */
export function completeImageRecipe(input:{imageBase:string;uid:number;gid:number;installedReleasePath:string}){
 assert(/^[-a-zA-Z0-9./_:]+@sha256:[a-f0-9]{64}$/.test(input.imageBase),"pinned_base_image_required");
 assert(Number.isSafeInteger(input.uid) && input.uid>0 && Number.isSafeInteger(input.gid) && input.gid>0);
 assert(/^\/[A-Za-z0-9_/-]+$/.test(input.installedReleasePath) && !input.installedReleasePath.split("/").includes(".."));
 const path=input.installedReleasePath;
 // The external issuer signs the resulting ACTUAL image ID after the build.
 // That record/configuration is mounted privately outside this release tree.
 return "FROM "+input.imageBase+"\nCOPY --chown="+input.uid+":"+input.gid+" release/ "+path+"/\n"+
  "RUN chmod -R a-w "+path+"\nUSER "+input.uid+":"+input.gid+
  "\nENV NODE_PATH=\"\" NODE_OPTIONS=\"\"\nENTRYPOINT "+JSON.stringify([
   path+"/toolchain/node","--import",path+"/toolchain/node_modules/tsx/dist/loader.mjs",
   path+"/source/deploy/linux/local-install-main.ts"])+"\n";
}

