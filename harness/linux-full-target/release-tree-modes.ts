import assert from "node:assert/strict";
import {chmod,lstat,readdir} from "node:fs/promises";
import {join,relative} from "node:path";

/** Normalize and verify every release file's mode for the container user.
 * The image recipe copies this tree to the container user, and the umask of
 * the building process must never decide readability: a build under umask
 * 077 turns the intended 0o444 into 0o400, and workerd then aborts TLS
 * setup because the CA bundle is unreadable. The seal is the build gate:
 * every file ends readable by the container user or the build fails. */
export async function sealReleaseTree(root:string){
 const containerPrivate=new Set(["source/backend.ts"]);
 async function seal(path:string){for(const row of await readdir(path,{withFileTypes:true})){
  const child=join(path,row.name);assert(!row.isSymbolicLink(),"release_tree_symlink_refused");
  if(row.isDirectory()){await seal(child);continue;}
  assert(row.isFile(),"release_tree_unexpected_entry");
  const relativePath=relative(root,child);
  const before=await lstat(child);
  assert(!(before.mode&0o222),"release_tree_writable_refused");
  const targetMode=(before.mode&0o111)!==0?0o555:containerPrivate.has(relativePath)?0o400:0o444;
  await chmod(child,targetMode);
  const after=await lstat(child);
  assert((after.mode&0o777)===targetMode,"release_tree_mode_normalization_failed");
  assert((after.mode&0o400)!==0,"release_file_not_readable_by_container_user");
 }await chmod(path,0o555);}
 await seal(root);
 // The CA bundle is copied into the image root-owned, so it must stay
 // world-readable; the recipe's COPY --chmod=0644 is the second gate.
 const ca=join(root,"toolchain/ca-certificates.crt");
 assert(((await lstat(ca)).mode&0o777)===0o444,"release_ca_bundle_not_world_readable");
}
