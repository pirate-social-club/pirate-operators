import {initializeNativeOriginal} from "../../packages/community/native-business-binding.ts";
import {initializeWeb2NativeOriginal} from "../../packages/community/web2-native-business-binding.ts";
import {web2ApplicationOriginal} from "../../services/application-native-readback.ts";
import {initializeNativePostsCustody} from "../../services/linux-web2-posts-custody.ts";
import {initializeWeb2Schema, selectWeb2PublicationConsent} from "./web2-initialization.ts";
import {initializeNativePublication, initializeTrustedNativePublication} from "./web2-publication-selection.ts";
/** Private one-shot bootstrap. No user-facing listener or caller-supplied SQL. */
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/initialize')
      return new Response(null, { status: 404 });
    const plan = JSON.parse(env.MIGRATION_PLAN_JSON);
    if (plan.schema !== 'pirate.linux-migration-plan/1' || plan.qualificationOnly !== true)
      throw new Error('Unqualified migration plan');
    const retained = env.WEB2_REQUIRE_RETAINED_STATE === '1';
    const trustedPublication = env.WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON;
    const trustedExpiry = env.WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS;
    if (trustedPublication !== undefined || trustedExpiry !== undefined) {
      if (!retained) throw new Error('Trusted publication requires the retained Web2 original');
      if (typeof trustedPublication !== 'string' || typeof trustedExpiry !== 'string' ||
          !/^[1-9][0-9]{0,15}(?![\s\S])/.test(trustedExpiry) ||
          !Number.isSafeInteger(Number(trustedExpiry)))
        throw new Error('Trusted publication cutoff missing or invalid');
    }
    function originalIsWeb2() {
      if (!env.NATIVE_APPLICATION_ORIGINAL_JSON) throw new Error('Native original binding missing');
      return JSON.parse(env.NATIVE_APPLICATION_ORIGINAL_JSON).schema === "pirate.web2-native-application-original/1";
    }
    const key = '_qualification/' + plan.releaseSha256;
    const bytes = 'pirate-linux-native-object:' + plan.releaseSha256;
    async function readOriginalObject() {
      const object = await env.MEDIA.get(key);
      if (!object || object.customMetadata.release !== plan.releaseSha256 ||
        new TextDecoder().decode(await object.arrayBuffer()) !== bytes)
        throw new Error('Native object readback changed');
      return object;
    }
    if (retained) {
      if (!originalIsWeb2() || env.POSTS_CUSTODY_SELECTION_JSON !== undefined || env.POSTS_CUSTODY_HOST_AUTH !== undefined ||
          env.WEB2_PUBLICATION_INITIALIZATION_JSON !== undefined)
        throw new Error('Trusted retained Web2 scope changed');
      const original = await web2ApplicationOriginal(env);
      const draft = original.record.body.draft;
      const identity = await env.DB.withSession("first-primary").prepare(
        "SELECT id FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?",
      ).bind(draft.enrollment.communityId, draft.origin).first();
      if (!identity) throw new Error('Trusted retained application identity changed');
      await readOriginalObject();
    } else await env.DB.prepare(`CREATE TABLE IF NOT EXISTS _pirate_linux_migrations(
      ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
      release_sha256 TEXT NOT NULL)`).run();
    const saved = (await env.DB.prepare('SELECT * FROM _pirate_linux_migrations ORDER BY ordinal').all()).results;
    if (saved.length > plan.migrations.length) throw new Error('Foreign migration ledger');
    if (retained && saved.length !== plan.migrations.length) throw new Error('Incomplete retained migration ledger');
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
    let publicationSelectionSha256;
    if (originalIsWeb2()) {
      if (!plan.web2Schema) throw new Error('Explicit fresh Web2 schema plan missing');
      const postsCustody = env.POSTS_CUSTODY_SELECTION_JSON !== undefined ||
        env.POSTS_CUSTODY_HOST_AUTH !== undefined;
      const publicationConsent = selectWeb2PublicationConsent(plan.migrations);
      await initializeWeb2Schema(env.DB, plan.web2Schema, plan.releaseSha256, { postsCustody, publicationConsent, requireRetained: retained });
      if (!retained) await initializeWeb2NativeOriginal(env.DB, env.NATIVE_APPLICATION_ORIGINAL_JSON);
      if (postsCustody) {
        const original = await web2ApplicationOriginal(env);
        await initializeNativePostsCustody(env, original.record.body.draft.deployment, original);
      }
      if (env.WEB2_PUBLICATION_INITIALIZATION_JSON !== undefined) {
        const raw = env.WEB2_PUBLICATION_INITIALIZATION_JSON;
        if (!raw || new TextEncoder().encode(raw).length > 5 * 1024 ** 2)
          throw new Error("Native publication initialization is invalid");
        publicationSelectionSha256 = await initializeNativePublication(env.DB,
          await web2ApplicationOriginal(env), JSON.parse(raw));
      }
    } else {
      if (plan.web2Schema || env.WEB2_PUBLICATION_INITIALIZATION_JSON !== undefined ||
          env.POSTS_CUSTODY_SELECTION_JSON !== undefined || env.POSTS_CUSTODY_HOST_AUTH !== undefined)
        throw new Error('Web2 schema cannot alter historical profile');
      await initializeNativeOriginal(env.DB, env.NATIVE_APPLICATION_ORIGINAL_JSON);
    }
    const checks = await env.DB.prepare('PRAGMA foreign_key_check').all();
    if (checks.results.length) throw new Error('Foreign-key violations');
    if (trustedPublication !== undefined) {
      if (!selectWeb2PublicationConsent(plan.migrations))
        throw new Error('Trusted publication migration ledger missing');
      publicationSelectionSha256 = await initializeTrustedNativePublication(env.DB,
        await web2ApplicationOriginal(env), trustedPublication, Number(trustedExpiry));
    }
    // Native R2 binding proof on a fresh, private qualification key, not an app-media claim.
    if (!retained) {
      const objectBytes = new TextEncoder().encode(bytes);
      const expected = await crypto.subtle.digest('SHA-256', objectBytes);
      await env.MEDIA.put(key, objectBytes, { sha256: expected,
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { release: plan.releaseSha256 } });
    }
    const read = await readOriginalObject();
    return Response.json({ initialized: true, migrations: plan.migrations.length,
      releaseSha256: plan.releaseSha256, nativeObjectKey: key, objectEtag: read.etag,
      ...(retained ? { retainedState: true } : {}),
      ...(publicationSelectionSha256 ? {publicationSelectionSha256} : {}) });
  },
};
