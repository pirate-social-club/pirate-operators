import {initializeNativeOriginal} from "../../packages/community/native-business-binding.ts";
/** Private one-shot bootstrap. No user-facing listener or caller-supplied SQL. */
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/initialize')
      return new Response(null, { status: 404 });
    const plan = JSON.parse(env.MIGRATION_PLAN_JSON);
    if (plan.schema !== 'pirate.linux-migration-plan/1' || plan.qualificationOnly !== true)
      throw new Error('Unqualified migration plan');
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS _pirate_linux_migrations(
      ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
      release_sha256 TEXT NOT NULL)`).run();
    const saved = (await env.DB.prepare('SELECT * FROM _pirate_linux_migrations ORDER BY ordinal').all()).results;
    if (saved.length > plan.migrations.length) throw new Error('Foreign migration ledger');
    for (const [index, migration] of plan.migrations.entries()) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(migration.sql))), (v) => v.toString(16).padStart(2, '0')).join('');
      if (digest !== migration.sha256 || migration.statements.join('') !== migration.sql)
        throw new Error('Migration bytes changed');
      if (index < saved.length) {
        const row = saved[index];
        if (row.ordinal !== index + 1 || row.name !== migration.name || row.sha256 !== migration.sha256 ||
          row.release_sha256 !== plan.releaseSha256) throw new Error('Migration ledger changed');
        continue;
      }
      await env.DB.batch([
        ...migration.statements.filter((sql) => sql.trim()).map((sql) => env.DB.prepare(sql)),
        env.DB.prepare('INSERT INTO _pirate_linux_migrations VALUES(?,?,?,?)')
          .bind(index + 1, migration.name, migration.sha256, plan.releaseSha256),
      ]);
    }
    // The new draft must be assigned a real contiguous ordinal by Root and be
    // present in the exact signed migration set; no runtime DDL is invented here.
    if (!env.NATIVE_APPLICATION_ORIGINAL_JSON) throw new Error('Native original binding missing');
    await initializeNativeOriginal(env.DB, env.NATIVE_APPLICATION_ORIGINAL_JSON);
    const checks = await env.DB.prepare('PRAGMA foreign_key_check').all();
    if (checks.results.length) throw new Error('Foreign-key violations');
    // Native R2 binding proof on a fresh, private qualification key, not an app-media claim.
    const bytes = new TextEncoder().encode('pirate-linux-native-object:' + plan.releaseSha256);
    const expected = await crypto.subtle.digest('SHA-256', bytes);
    const key = '_qualification/' + plan.releaseSha256;
    await env.MEDIA.put(key, bytes, { sha256: expected,
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { release: plan.releaseSha256 } });
    const read = await env.MEDIA.get(key);
    if (!read || read.customMetadata.release !== plan.releaseSha256 ||
      new TextDecoder().decode(await read.arrayBuffer()) !== new TextDecoder().decode(bytes))
      throw new Error('Native object readback changed');
    return Response.json({ initialized: true, migrations: plan.migrations.length,
      releaseSha256: plan.releaseSha256, nativeObjectKey: key, objectEtag: read.etag });
  },
};
