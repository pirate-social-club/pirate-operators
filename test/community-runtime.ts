import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

export async function communityRuntime() {
  // Semantic D1/R2 qualification with the pinned local engine, not live
  // acceptance of the deployed November compatibility date.
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
  });
  try {
    const db = await runtime.getD1Database("DB"),
      // Miniflare's RPC proxy types erase native Date internals. The runtime
      // object exposes the real R2 API exercised below, not a storage mock.
      media = (await runtime.getR2Bucket("MEDIA")) as unknown as R2Bucket;
    for (const name of [
      "0001_setup.sql",
      "0002_first_song.sql",
      "0003_publication_journal.sql",
      "0004_creator_connection.sql",
    ]) {
      const sql = await readFile(
        new URL(
          `../apps/community-wizard/infra/migrations/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    return { db, media, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
