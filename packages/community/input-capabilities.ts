import { hashText, insist, token } from "./common.ts";
import { httpsOrigin } from "./manifest-core.ts";
import type { SongMetadata, Submission } from "./submissions.ts";
import type { Capability } from "../moderation/capabilities.ts";

interface CapabilityMedia {
  get(
    key: string,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    etag: string;
    size: number;
    customMetadata?: Record<string, string>;
  } | null>;
}
type Kind = "audio" | "title" | "lyrics";
function textInput(row: Submission, kind: "title" | "lyrics") {
  const metadata = JSON.parse(row.metadata_json) as SongMetadata;
  return new TextEncoder().encode(
    kind === "title" ? metadata.title : metadata.lyrics.sourceText,
  );
}
/** Tokens grant only a sealed input, expire, and are stored as hashes. They
 * contain no account/wallet identifiers and never authorize a publication. */
export async function createInputCapabilities(
  db: D1Database,
  row: Submission,
  origin: string,
  now = Math.floor(Date.now() / 1000),
) {
  insist(row.upload_state === "sealed", "input_not_sealed", 409);
  origin = httpsOrigin(origin);
  const expiresAt = now + 900;
  const capabilities = {} as Record<Kind, Capability>;
  const inserts = [];
  for (const kind of ["audio", "title", "lyrics"] as const) {
    const bytes = kind === "audio" ? null : textInput(row, kind);
    if (kind === "lyrics" && !bytes!.length) continue;
    const sha256 =
      kind === "audio"
        ? row.audio_sha256
        : hashText(new TextDecoder().decode(bytes!));
    const byteLength = kind === "audio" ? row.audio_bytes : bytes!.length;
    const secret = token();
    capabilities[kind] = {
      url: `${origin}/api/moderation/inputs/${row.submission_id}/${kind}?cap=${secret}`,
      sha256: sha256 as Capability["sha256"],
      byteLength,
      expiresAt,
    };
    inserts.push(
      db
        .prepare(
          "INSERT INTO moderation_input_capabilities(capability_hash,submission_id,input_kind,sha256,byte_length,expires_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          hashText(secret),
          row.submission_id,
          kind,
          sha256,
          byteLength,
          expiresAt,
        ),
    );
  }
  await db.batch([
    db
      .prepare("DELETE FROM moderation_input_capabilities WHERE expires_at<=?")
      .bind(now),
    ...inserts,
  ]);
  return {
    song: capabilities.audio,
    title: capabilities.title,
    lyrics: capabilities.lyrics ?? null,
  };
}
export async function serveInputCapability(
  request: Request,
  db: D1Database,
  media: CapabilityMedia,
  origin: string,
  now = Math.floor(Date.now() / 1000),
) {
  const url = new URL(request.url),
    match =
      /^\/api\/moderation\/inputs\/([a-f0-9-]{36})\/(audio|title|lyrics)$/.exec(
        url.pathname,
      );
  insist(
    request.method === "GET" &&
      url.origin === origin &&
      match &&
      [...url.searchParams.keys()].length === 1 &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get("cap") ?? ""),
    "input_capability_required",
    403,
  );
  const id = match[1]!,
    kind = match[2] as Kind,
    secret = url.searchParams.get("cap")!;
  const capability = await db
    .prepare(
      "SELECT sha256,byte_length FROM moderation_input_capabilities WHERE capability_hash=? AND submission_id=? AND input_kind=? AND expires_at>?",
    )
    .bind(hashText(secret), id, kind, now)
    .first<{ sha256: string; byte_length: number }>();
  insist(capability, "input_capability_expired_or_invalid", 403);
  const row = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE submission_id=? AND upload_state='sealed'",
    )
    .bind(id)
    .first<Submission>();
  insist(row, "sealed_input_unavailable", 503);
  const headers = {
    "cache-control": "no-store",
    "content-type":
      kind === "audio" ? "audio/mpeg" : "text/plain; charset=utf-8",
    "content-length": String(capability.byte_length),
    "x-content-type-options": "nosniff",
  };
  if (kind === "audio") {
    insist(
      row.audio_sha256 === capability.sha256 &&
        row.audio_bytes === capability.byte_length,
      "input_capability_binding_changed",
      503,
    );
    const object = await media.get(row.object_key);
    insist(
      object &&
        object.etag === row.object_etag &&
        object.size === row.audio_bytes &&
        object.customMetadata?.sha256 === row.audio_sha256,
      "sealed_input_unavailable",
      503,
    );
    return new Response(object.body, { headers });
  }
  const bytes = textInput(row, kind);
  insist(
    bytes.length === capability.byte_length &&
      hashText(new TextDecoder().decode(bytes)) === capability.sha256,
    "input_capability_binding_changed",
    503,
  );
  return new Response(bytes, { headers });
}
