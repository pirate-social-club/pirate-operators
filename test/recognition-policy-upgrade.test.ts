// UNRUN; historical pending jobs are migration fixtures, never ready catalog rows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { communityRuntime } from "./community-runtime.ts";
import { hashJson } from "../packages/community/common.ts";
import { OWNER_POLICY_VERSION,OWNER_POLICY_HASH,UNREGISTERED_OWNER_POLICY_VERSION,UNREGISTERED_OWNER_POLICY_HASH,
  CATALOG_OWNER_POLICY_VERSION,CATALOG_OWNER_POLICY_HASH } from "../packages/community/owner-policy.ts";
import { jobSteps,leaseJob } from "../packages/community/publication-store.ts";
import { rows } from "./recognition-reservation-helpers.ts";
import { catalogPhaseTransitionSql, catalogPhaseTransitionStatements } from "../packages/community/catalog-phase-transition.ts";
import { Miniflare } from "miniflare";
import { migrateOwnerDatabase } from "./owner-publishing-migration-fixture.ts";

test('unnumbered phase rebuild preserves every captured job/operation byte and foreign-key identity',async()=>{
  const f=await communityRuntime();try {
    await f.db.prepare('INSERT INTO community_accounts VALUES(?,?,?)').bind('historic-account','0x'+'12'.repeat(32),1).run();
    const policy={version:UNREGISTERED_OWNER_POLICY_VERSION,sha256:UNREGISTERED_OWNER_POLICY_HASH};
    await f.db.prepare(`INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
      VALUES('historic','historic-account',? ,?,'original-key',?,'{"acceptedPolicy":"historic"}',?,'null',?,1,'staging/historic','sealed',1)`)
      .bind('0x'+'12'.repeat(32),'0x'+'13'.repeat(32),hashJson({original:true}),'0x'+'14'.repeat(20),'0x'+'15'.repeat(32)).run();
    await f.db.prepare(`INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,progress_json,revision,lease_token,lease_until,due_at,attempts,error_code,created_at,updated_at)
      VALUES('publication:historic','historic',?,?,'uncertain','{"resumePhase":"publication","captured":"unchanged"}',7,'retained-lease',77,88,9,'external_result_uncertain',1,2)`)
      .bind(hashJson({immutable:'input'}),JSON.stringify({policy,captured:'original'})).run();
    await f.db.prepare(`INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status,prepared_json)
      VALUES('retained-operation','publication:historic','publication',?,'{"captured":"request"}','uncertain','{"captured":"original signed bytes and nonce"}')`)
      .bind(hashJson({captured:'request'})).run();
    // Preserve populated children as well as the parent and signed-operation journal.
    await f.db.prepare("INSERT INTO external_operation_reconciliations VALUES(?,?,?,?)")
      .bind('retained-operation',hashJson({proof:'original absence'}),'{"proof":"original absence"}',4).run();
    await f.db.prepare("INSERT INTO publication_amendments VALUES(?,?,?,?,?,?)")
      .bind('publication:historic',hashJson({amendment:'original'}),'{"signed":"original amendment"}','retained-operation','retained-successor',5).run();
    const reconciliations=await rows(f.db,'external_operation_reconciliations'),amendments=await rows(f.db,'publication_amendments');
    const tables=['publication_jobs','external_operations','external_operation_reconciliations','publication_amendments'];
    const identities=async()=>Promise.all(tables.map(table=>f.db.prepare("SELECT rowid AS retained_rowid,* FROM "+table+" ORDER BY rowid").all()));
    const beforeIdentities=(await identities()).map(result=>result.results);
    const schema=async()=>f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('publication_jobs','external_operations','external_operation_reconciliations','publication_amendments') ORDER BY type,name").all<{type:string;name:string;tbl_name:string;sql:string|null}>();
    const beforeSchema=(await schema()).results;
    const jobs=await rows(f.db,'publication_jobs'),operations=await rows(f.db,'external_operations');
    const draft=await readFile(new URL('../packages/community/catalog-phase-rebuild.sql',import.meta.url),'utf8');
    const statements=catalogPhaseTransitionSql(draft);
    const transition=catalogPhaseTransitionStatements(f.db,draft);
    const firstRename=statements.findIndex(statement=>statement.startsWith('ALTER TABLE publication_jobs_catalog_next RENAME'));
    assert.ok(firstRename>0);
    // Fail after the old component has been dropped, before staged names are published.
    // A real D1 batch must restore both DDL and rows atomically.
    await assert.rejects(f.db.batch([
      ...transition.slice(0,firstRename),
      f.db.prepare("INSERT INTO transaction_guards(guard_id,valid) VALUES('forced-phase-rebuild-rollback',0)"),
      ...transition.slice(firstRename),
    ]));
    assert.deepEqual((await schema()).results,beforeSchema);
    assert.deepEqual((await identities()).map(result=>result.results),beforeIdentities);
    assert.equal((await f.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_catalog_next%'").all()).results.length,0);
    await f.db.batch(catalogPhaseTransitionStatements(f.db,draft));
    assert.deepEqual(await rows(f.db,'publication_jobs'),jobs);assert.deepEqual(await rows(f.db,'external_operations'),operations);
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    assert.deepEqual(await rows(f.db,'external_operation_reconciliations'),reconciliations);
    assert.deepEqual(await rows(f.db,'publication_amendments'),amendments);
    assert.deepEqual((await identities()).map(result=>result.results),beforeIdentities);
    const normalize=(sql:string)=>sql.replace(/"([a-z_][a-z0-9_]*)"/gi,'$1').replace(/\s+/g,' ').trim();
    const expectedSchema=beforeSchema.map(entry=>({...entry,sql:entry.sql===null?null:normalize(entry.tbl_name==='publication_jobs'&&entry.type==='table'
      ?entry.sql.replace("'published','held'","'catalog_reserve','catalog_confirm','published','held'"):entry.sql)}));
    assert.deepEqual((await schema()).results.map(entry=>({...entry,sql:entry.sql===null?null:normalize(entry.sql)})),expectedSchema);
    // A successfully swapped schema must still enforce parent, child and uniqueness constraints.
    await assert.rejects(f.db.prepare("INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status) VALUES('orphan','missing-job','publication','h','{}','planned')").run());
    await assert.rejects(f.db.prepare("INSERT INTO external_operation_reconciliations VALUES('missing-operation','h','{}',0)").run());
    await assert.rejects(f.db.prepare("INSERT INTO publication_amendments VALUES('missing-job','h','{}','missing-operation','s',0)").run());
    await assert.rejects(f.db.prepare("INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status) VALUES('duplicate-step','publication:historic','publication','h','{}','planned')").run());
  }finally{await f.dispose();}
});
test('old captured policies keep their exact sequence while the separately versioned policy requires both catalog steps',()=>{
  const policy=(version:string,sha256:string)=>({authority_json:JSON.stringify({policy:{version,sha256}})});
  assert.deepEqual(jobSteps(policy(OWNER_POLICY_VERSION,OWNER_POLICY_HASH)),['admission','pin_audio','pin_lyrics','registration','pin_manifest','publication']);
  assert.deepEqual(jobSteps(policy(UNREGISTERED_OWNER_POLICY_VERSION,UNREGISTERED_OWNER_POLICY_HASH)),['admission','pin_audio','pin_lyrics','pin_manifest','publication']);
  assert.deepEqual(jobSteps(policy(CATALOG_OWNER_POLICY_VERSION,CATALOG_OWNER_POLICY_HASH)),['catalog_reserve','pin_audio','pin_lyrics','pin_manifest','publication','catalog_confirm']);
});

// Every refusal uses real local workerd D1 and pending captured history.
// Prepare the transition before installing the unexpected object: a cached
// application precheck cannot satisfy this test's in-batch schema fence.
async function retainedHistory(database: D1Database) {
  await database.prepare("INSERT INTO community_accounts VALUES('schema-account',?,1)")
    .bind('0x'+'22'.repeat(32)).run();
  await database.prepare("INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at) VALUES('schema-song','schema-account',?,?,'retained-key',?,'{}',?,'null',?,1,'staging/schema-song','sealed',1)")
    .bind('0x'+'22'.repeat(32),'0x'+'23'.repeat(32),hashJson({request:'retained'}),'0x'+'24'.repeat(20),'0x'+'25'.repeat(32)).run();
  await database.prepare(`INSERT INTO publication_jobs(rowid,job_id,submission_id,input_hash,authority_json,phase,progress_json,revision,lease_token,lease_until,due_at,attempts,error_code,created_at,updated_at) VALUES(101,'schema-job','schema-song',?,?,'uncertain','{"resumePhase":"publication"}',17,'retained-lease',123,124,6,'external_result_uncertain',1,2)`)
    .bind(hashJson({input:'retained'}),JSON.stringify({policy:{version:UNREGISTERED_OWNER_POLICY_VERSION,sha256:UNREGISTERED_OWNER_POLICY_HASH}})).run();
  await database.prepare(`INSERT INTO external_operations(rowid,operation_id,job_id,step,request_hash,request_json,status,prepared_json,provider_id,result_json,error_code,started_at,completed_at) VALUES(202,'schema-operation','schema-job','publication',?,'{"request":"retained"}','uncertain','{"signedBytes":"retained","nonce":"9","transactionHash":"retained"}','retained-provider','{"unknownEffect":true}','external_result_uncertain',3,4)`)
    .bind(hashJson({operation:'retained'})).run();
  await database.prepare(`INSERT INTO external_operation_reconciliations(rowid,operation_id,proof_sha256,proof_json,observed_at) VALUES(303,'schema-operation',?,'{"proof":"retained"}',5)`)
    .bind(hashJson({proof:'retained'})).run();
  await database.prepare(`INSERT INTO publication_amendments(rowid,job_id,amendment_sha256,signed_json,predecessor_operation_id,successor_operation_id,created_at) VALUES(404,'schema-job',?,'{"signed":"retained"}','schema-operation','retained-successor',6)`)
    .bind(hashJson({amendment:'retained'})).run();
}
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
async function completeDatabase(database: D1Database) {
  const schema=(await database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all<{type:string;name:string;tbl_name:string;sql:string|null}>()).results;
  const tables=await Promise.all(schema.filter(entry=>entry.type==='table'&&!entry.name.startsWith('sqlite_')).map(async entry=>({
    name:entry.name,
    rows:(await database.prepare("SELECT rowid AS retained_rowid,* FROM "+identifier(entry.name)+" ORDER BY rowid").all()).results,
  })));
  return {schema,tables};
}
const refusalCases = [
  {
    name:'unexpected affected index',
    sql:["CREATE INDEX custom_catalog_updated ON publication_jobs(updated_at)"],
  },
  {
    name:'changed same-named affected index',
    sql:["DROP INDEX due_publication_jobs","CREATE INDEX due_publication_jobs ON publication_jobs(phase,updated_at,lease_until)"],
  },
  {
    name:'unexpected affected trigger',
    sql:[
      "CREATE TABLE custom_catalog_audit(value TEXT)",
      "INSERT INTO custom_catalog_audit VALUES('retained')",
      "CREATE TRIGGER custom_catalog_delete AFTER DELETE ON publication_jobs BEGIN INSERT INTO custom_catalog_audit VALUES(OLD.job_id); END",
    ],
  },
  {
    name:'unexpected trigger on another table referencing the component',
    sql:["CREATE TRIGGER custom_catalog_cross AFTER UPDATE ON community_accounts BEGIN UPDATE publication_jobs SET attempts=attempts+1 WHERE job_id='schema-job'; END"],
  },
  {
    name:'unexpected empty incoming foreign-key table',
    sql:["CREATE TABLE custom_catalog_child(child_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES publication_jobs(job_id) ON DELETE CASCADE)"],
  },
  {
    name:'unexpected populated incoming foreign-key table',
    sql:[
      "CREATE TABLE custom_catalog_child(child_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES publication_jobs(job_id) ON DELETE CASCADE)",
      "INSERT INTO custom_catalog_child VALUES('retained-child','schema-job')",
    ],
  },
  {
    name:'changed affected table schema',
    sql:["ALTER TABLE publication_jobs ADD COLUMN retained_custom_note TEXT NOT NULL DEFAULT 'operator retained' CHECK(retained_custom_note <> '')"],
  },
  {
    name:'unexpected view referencing the component',
    sql:["CREATE VIEW custom_catalog_view AS SELECT job_id,phase,updated_at FROM publication_jobs"],
  },
];
for (const scenario of refusalCases) {
  test('atomic phase rebuild refuses '+scenario.name+' and preserves the complete database',async()=>{
    const f=await communityRuntime();
    try {
      await retainedHistory(f.db);
      const draft=await readFile(new URL('../packages/community/catalog-phase-rebuild.sql',import.meta.url),'utf8');
      const transition=catalogPhaseTransitionStatements(f.db,draft);
      // The schema changes after the caller prepared its statements.
      await f.db.batch(scenario.sql.map(statement=>f.db.prepare(statement)));
      const before=await completeDatabase(f.db);
      const foreignKeys=(await f.db.prepare('PRAGMA foreign_key_check').all()).results;
      assert.equal(foreignKeys.length,0);
      await assert.rejects(f.db.batch([
        // These actual writes precede the refusal and must also roll back.
        f.db.prepare("INSERT INTO transaction_guards VALUES('schema-refusal-rollback-marker',1)"),
        f.db.prepare("UPDATE publication_jobs SET attempts=attempts+1,updated_at=999 WHERE job_id='schema-job'"),
        ...transition,
      ]),/catalog_phase_schema_refusal/);
      assert.deepEqual(await completeDatabase(f.db),before);
      assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,foreignKeys);
      assert.equal((await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='catalog_phase_schema_guard' OR name LIKE '%_catalog_next%'").all()).results.length,0);
    } finally {await f.dispose();}
  });
}

test('guarded phase rebuild retains the exact full nineteen-migration D1 schema and history',async()=>{
  // Use the existing pinned Alchemy migration executor/parser and actual D1
  // transport; complete trigger bodies reach the same real db.batch boundary.
  const runtime=new Miniflare({
    modules:true,
    script:"export default {fetch(){return new Response('fixture')}}",
    compatibilityDate:"2026-08-06",
    d1Databases:["DB"],
  });
  try {
    const database=await runtime.getD1Database("DB");
    await migrateOwnerDatabase(database,[
      "apps/community-wizard/infra/migrations/0001_setup.sql",
      "apps/community-wizard/infra/migrations/0002_first_song.sql",
      "apps/community-wizard/infra/migrations/0003_publication_journal.sql",
      "apps/community-wizard/infra/migrations/0004_creator_connection.sql",
      "apps/community-wizard/infra/migrations/0005_input_capabilities.sql",
      "apps/community-wizard/infra/migrations/0006_song_stems.sql",
      "apps/community-wizard/infra/migrations/0007_owner_curated.sql",
      "apps/community-wizard/infra/migrations/0008_karaoke.sql",
      "apps/community-wizard/infra/migrations/0009_study.sql",
      "apps/community-wizard/infra/migrations/0010_study_retention.sql",
      "apps/community-wizard/infra/migrations/0011_manual_rewards.sql",
      "apps/community-wizard/infra/migrations/0012_owner_budget_windows.sql",
      "apps/community-wizard/infra/migrations/0013_learning_authorization.sql",
      "apps/community-wizard/infra/migrations/0014_reward_closure_snapshots.sql",
      "apps/community-wizard/infra/migrations/0015_community_media.sql",
      "apps/community-wizard/infra/migrations/0016_dance.sql",
      "apps/community-wizard/infra/migrations/0017_dance_canonical_controls.sql",
      "apps/community-wizard/infra/migrations/0018_learning_authority.sql",
      "apps/community-wizard/infra/migrations/0019_community_profiles.sql",
    ]);
    await retainedHistory(database);
    const before=await completeDatabase(database);
    const draft=await readFile(new URL('../packages/community/catalog-phase-rebuild.sql',import.meta.url),'utf8');
    await database.batch(catalogPhaseTransitionStatements(database,draft));
    const after=await completeDatabase(database);
    assert.deepEqual(after.tables,before.tables);
    const affected=new Set(['publication_jobs','external_operations','external_operation_reconciliations','publication_amendments']);
    assert.deepEqual(after.schema.filter(entry=>!affected.has(entry.tbl_name)),before.schema.filter(entry=>!affected.has(entry.tbl_name)));
    assert.equal((await database.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    assert.equal((await database.prepare("SELECT name FROM sqlite_schema WHERE name='catalog_phase_schema_guard' OR name LIKE '%_catalog_next%'").all()).results.length,0);
  } finally {await runtime.dispose();}
});
