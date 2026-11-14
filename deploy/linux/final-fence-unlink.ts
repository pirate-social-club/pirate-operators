import assert from "node:assert/strict";
import {constants,fstatSync,lstatSync,realpathSync,readSync} from "node:fs";
import {open,unlink,lstat as lstatAsync} from "node:fs/promises";
import {dirname} from "node:path";
import {privateDirectory,privateFile,hash} from "./backend-state.ts";

export async function pinOriginalFence(path:string,maxBytes:number){
  const parent=dirname(path);await privateDirectory(parent);
  const parentBefore=await lstatAsync(parent);
  const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let file:Awaited<ReturnType<typeof privateFile>>|undefined;
  try{
    const parentId=await directory.stat();
    assert(parentId.dev===parentBefore.dev && parentId.ino===parentBefore.ino,"fence_parent_changed");
    file=await privateFile(path,maxBytes);
    const before=await file.stat({bigint:true}),bytes=await file.readFile(),after=await file.stat({bigint:true});
    assert(before.dev===after.dev && before.ino===after.ino && before.size===after.size &&
      before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs,"original_fence_changed");
    const identity=await file.stat(),expectedHash=hash(bytes);
    await directory.sync(); // All durability/preparation awaits precede authority.
    const held=file;
    function assertUnchangedSync(){
      const p=lstatSync(parent),pd=fstatSync(directory.fd),named=lstatSync(path),fd=fstatSync(held.fd);
      assert(realpathSync(parent)===parent && p.isDirectory() && !p.isSymbolicLink() &&
        p.dev===parentId.dev && p.ino===parentId.ino && pd.dev===parentId.dev && pd.ino===parentId.ino &&
        p.uid===parentId.uid && pd.uid===parentId.uid && !(p.mode&0o077) && !(pd.mode&0o077) &&
        (p.mode&0o7777)===(parentId.mode&0o7777),"fence_parent_changed");
      assert(realpathSync(path)===path && named.isFile() && !named.isSymbolicLink() && fd.isFile() &&
        named.dev===identity.dev && named.ino===identity.ino && fd.dev===identity.dev && fd.ino===identity.ino &&
        named.nlink===1 && fd.nlink===1 && named.uid===identity.uid && fd.uid===identity.uid &&
        !(named.mode&0o077) && !(fd.mode&0o077) && (named.mode&0o7777)===(identity.mode&0o7777) &&
        (fd.mode&0o7777)===(identity.mode&0o7777) && named.size===bytes.length && fd.size===bytes.length,
        "original_fence_changed");
      const stamp=fstatSync(held.fd,{bigint:true}),copy=Buffer.alloc(bytes.length);let offset=0;
      while(offset<copy.length){const n=readSync(held.fd,copy,offset,copy.length-offset,offset);
        assert(n>0,"original_fence_changed");offset+=n;}
      const last=fstatSync(held.fd,{bigint:true}),namedLast=lstatSync(path),parentLast=lstatSync(parent);
      assert(stamp.dev===last.dev && stamp.ino===last.ino && stamp.size===last.size &&
        stamp.mtimeNs===last.mtimeNs && stamp.ctimeNs===last.ctimeNs && hash(copy)===expectedHash &&
        namedLast.dev===identity.dev && namedLast.ino===identity.ino && namedLast.nlink===1 && namedLast.isFile() &&
        namedLast.uid===identity.uid && (namedLast.mode&0o7777)===(identity.mode&0o7777) && !namedLast.isSymbolicLink() &&
        parentLast.dev===parentId.dev && parentLast.ino===parentId.ino && parentLast.isDirectory() &&
        parentLast.uid===parentId.uid && (parentLast.mode&0o7777)===(parentId.mode&0o7777) &&
        !parentLast.isSymbolicLink(),"original_fence_changed");
    }
    return {bytes,identity,parent,
      assertUnchangedSync,
      issueUnlink(signal:AbortSignal){
        assert(!signal.aborted,"native_effect_cancelled");assertUnchangedSync();
        assert(!signal.aborted,"native_effect_cancelled");
        return unlink(path); // Issue NOW; caller may await completion afterwards.
      },
      syncParent:()=>directory.sync(),
      async close(){try{await held.close();}finally{await directory.close();}}
    };
  }catch(error){try{await file?.close();}finally{await directory.close();}throw error;}
}
