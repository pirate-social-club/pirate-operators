import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { sha256 } from "viem";
import {
  createInputCapabilities,
  serveInputCapability,
} from "../packages/community/input-capabilities.ts";
import type { Submission } from "../packages/community/submissions.ts";

test("sealed-input capabilities bind one input and expire without exposing accounts or making R2 public", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
  });
  try {
    const db = await mf.getD1Database("DB"),
      // The local proxy carries its own Worker-types version. Runtime behavior
      // is exercised below; adapt only that test boundary.
      media = (await mf.getR2Bucket("MEDIA")) as unknown as R2Bucket,
      origin = "https://fixture.example";
    await db.exec(
      "CREATE TABLE media_submissions(submission_id TEXT PRIMARY KEY,metadata_json TEXT,upload_state TEXT,audio_sha256 TEXT,audio_bytes INTEGER,object_key TEXT,object_etag TEXT);",
    );
    const schema = await readFile(
      "packages/community/schema/input-capabilities.sql",
      "utf8",
    );
    await db.batch(
      schema
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    const bytes = new TextEncoder().encode(
        "explicit transport fixture, not a supported song",
      ),
      digest = sha256(bytes),
      id = crypto.randomUUID();
    const object = await media.put("private/sealed", bytes, {
      customMetadata: { sha256: digest },
    });
    await db
      .prepare("INSERT INTO media_submissions VALUES(?,?,?,?,?,?,?)")
      .bind(
        id,
        JSON.stringify({
          title: "Root asset",
          lyrics: { sourceText: "Words\nMore words" },
        }),
        "sealed",
        digest,
        bytes.length,
        "private/sealed",
        object!.etag,
      )
      .run();
    const row = await db
      .prepare("SELECT * FROM media_submissions")
      .first<Submission>();
    const caps = await createInputCapabilities(db, row!, origin, 1000);
    const audio = await serveInputCapability(
      new Request(caps.song.url),
      db,
      media,
      origin,
      1001,
    );
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
    assert.equal(audio.headers.get("cache-control"), "no-store");
    assert.equal(
      await (
        await serveInputCapability(
          new Request(caps.title.url),
          db,
          media,
          origin,
          1001,
        )
      ).text(),
      "Root asset",
    );
    assert.equal(
      await (
        await serveInputCapability(
          new Request(caps.lyrics!.url),
          db,
          media,
          origin,
          1001,
        )
      ).text(),
      "Words\nMore words",
    );
    const stored = JSON.stringify(
      (await db.prepare("SELECT * FROM moderation_input_capabilities").all())
        .results,
    );
    assert.equal(
      stored.includes(new URL(caps.song.url).searchParams.get("cap")!),
      false,
    );
    await assert.rejects(
      serveInputCapability(
        new Request(caps.song.url.replace("/audio?", "/title?")),
        db,
        media,
        origin,
        1001,
      ),
      /expired_or_invalid/,
    );
    await assert.rejects(
      serveInputCapability(new Request(caps.song.url), db, media, origin, 1900),
      /expired_or_invalid/,
    );
    await assert.rejects(
      serveInputCapability(
        new Request(caps.song.url + "&extra=1"),
        db,
        media,
        origin,
        1001,
      ),
      /capability_required/,
    );
    await assert.rejects(
      serveInputCapability(
        new Request(caps.song.url.replace(id, crypto.randomUUID())),
        db,
        media,
        origin,
        1001,
      ),
      /expired_or_invalid/,
    );
    await media.put("private/sealed", new TextEncoder().encode("changed"), {
      customMetadata: { sha256: digest },
    });
    await assert.rejects(
      serveInputCapability(new Request(caps.song.url), db, media, origin, 1001),
      /sealed_input_unavailable/,
    );
  } finally {
    await mf.dispose();
  }
});
