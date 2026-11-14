// UNRUN. Actual Ed25519 managed UDS, current signed policy and genuine closed
// Directory reader over controlled protocol transport. No host/provider claim.
import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdir,writeFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {fixture} from "./linux-current-authority-fixture.ts";
import {createProfileFixture} from "./linux-create-v3-fixture.ts";
import {startManagedKeyAgent,createManagedKeyClient} from "../deploy/linux/managed-key-channel.ts";
import {signRecord,canonicalDigest} from "../deploy/linux/installed-records.ts";
import {produceCreateOriginalProfile} from "../deploy/linux/profile-producer.ts";

test("actual managed producer requires fresh exact V3 approval and retains its immutable signed original",{timeout:30000},async()=>{
  const f=await fixture(),auth=randomBytes(32);
  let agent:Awaited<ReturnType<typeof startManagedKeyAgent>>|undefined,channel:Awaited<ReturnType<typeof createManagedKeyClient>>|undefined;
  try{
    const profile=createProfileFixture(f.reader.profile),profileDigest=canonicalDigest(profile),now=Date.now();
    const template={schema:"pirate.linux-create-template/1",installationId:f.installationId,generation:1,issuedAt:now-1000,expiresAt:now+60000,
      settings:profile.settings,identity:profile.identity,infrastructure:profile.infrastructure,runtime:profile.runtime,learning:profile.learning};
    const templateFile=join(f.root,"configuration","create-template.json"),outputDirectory=join(f.root,"profiles");
    await mkdir(outputDirectory,{mode:0o700});
    await writeFile(templateFile,JSON.stringify(signRecord(template,f.trust,f.key)),{mode:0o600,flag:"wx"});
    const signingKeyFile=join(f.root,"agent","profile-key");await writeFile(signingKeyFile,f.key,{mode:0o600,flag:"wx"});
    const socket=join(f.root,"agent","k.sock");
    agent=await startManagedKeyAgent({socket,directory:join(f.root,"agent"),installationId:f.installationId,authenticationKey:auth,
      lease:f.lease,keys:[],signingKeyFile,trust:f.trust,permittedProfileDigests:new Set([profileDigest]),capturedRoots:[join(f.root,"configuration")]});
    channel=await createManagedKeyClient({socket,installationId:f.installationId,authenticationKey:auth,lease:f.lease});
    const input={templateFile,trust:f.trust,requestId:"original-create-v3",draft:profile.settings,proof:f.proof,
      retainedIdentity:null,outputDirectory,lease:f.lease,channel,authority:f.authority};
    // The old V2 digest approval cannot authorize the smaller V3 preimage,
    // even though original namespace, mapping and resource IDs agree.
    await assert.rejects(produceCreateOriginalProfile(input),/profile_revoked_or_unapproved/);
    assert.deepEqual(await readdir(outputDirectory),[]);
    await f.save({...f.policy,profileDigests:[profileDigest]});
    const record=await produceCreateOriginalProfile(input);
    assert.deepEqual(record.body.profile,profile);assert.equal(record.body.profileDigest,profileDigest);
    assert.equal(record.body.requestId,input.requestId);assert.equal(record.body.installationId,f.installationId);
    assert.equal((await readdir(outputDirectory)).length,1);
    assert.deepEqual((await f.authority.admit(record,f.proof)).profile,profile);
    await f.save({...f.policy,profileDigests:[profileDigest],revokedRecordIds:[record.body.recordId]});
    await assert.rejects(f.authority.admit(record,f.proof),/profile_revoked_or_unapproved/);
  }finally{channel?.dispose();await agent?.close();auth.fill(0);await f.close();}
});
