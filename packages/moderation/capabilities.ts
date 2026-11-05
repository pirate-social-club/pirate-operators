import { sha256, type Hex } from "viem";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  MAX_AUDIO_BYTES,
  object,
  text,
} from "../community/common.ts";
import type { ManagedPairing } from "./pairing.ts";
import type { EvidenceCheck } from "./evidence.ts";

export interface Capability {
  url: string;
  sha256: Hex;
  byteLength: number;
  expiresAt: number;
}
export interface AdmissionRequest {
  jobId: string;
  submissionId: string;
  communityId: Hex;
  checks: EvidenceCheck[];
  inputs: { song: Capability; title: Capability; lyrics: Capability | null };
  declared: { songSha256: Hex; titleSha256: Hex; lyricsSha256: Hex | null };
}
function capability(
  value: unknown,
  pairing: ManagedPairing,
  submissionId: string,
  kind: "audio" | "title" | "lyrics",
  maximumBytes: number,
): Capability {
  const c = object(value);
  exact(c, ["url", "sha256", "byteLength", "expiresAt"]);
  const url = new URL(text(c.url, 2048));
  insist(
    url.origin === pairing.communityOrigin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === `/api/moderation/inputs/${submissionId}/${kind}` &&
      [...url.searchParams.keys()].length === 1 &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get("cap") ?? ""),
    "unpaired_media_capability",
    403,
  );
  return {
    url: url.toString(),
    sha256: bytes32(c.sha256),
    byteLength: integer(c.byteLength, 0, maximumBytes),
    expiresAt: integer(c.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
}
export function admissionRequest(
  value: unknown,
  pairing: ManagedPairing,
): AdmissionRequest {
  const r = object(value);
  exact(r, [
    "jobId",
    "submissionId",
    "communityId",
    "checks",
    "inputs",
    "declared",
  ]);
  const jobId = text(r.jobId, 128),
    submissionId = text(r.submissionId, 128);
  insist(
    /^[A-Za-z0-9:_-]{1,128}$/.test(jobId) &&
      /^[a-f0-9-]{36}$/.test(submissionId),
    "invalid_admission_identity",
  );
  insist(
    r.communityId === pairing.communityId,
    "cross_community_admission",
    403,
  );
  const inputs = object(r.inputs);
  exact(inputs, ["song", "title", "lyrics"]);
  const song = capability(
      inputs.song,
      pairing,
      submissionId,
      "audio",
      MAX_AUDIO_BYTES,
    ),
    title = capability(inputs.title, pairing, submissionId, "title", 800);
  insist(
    song.byteLength > 0 && title.byteLength > 0,
    "missing_admission_input",
  );
  const lyrics =
    inputs.lyrics === null
      ? null
      : capability(inputs.lyrics, pairing, submissionId, "lyrics", 131072);
  const contentChecks: EvidenceCheck[] = [
    "title.rating",
    ...(lyrics ? ["lyrics.classification" as const] : []),
  ];
  const sets: EvidenceCheck[][] = [
    ["audio.identification"],
    contentChecks,
    ["audio.identification", ...contentChecks],
  ];
  const checks = sets.find((checks) => hashJson(r.checks) === hashJson(checks));
  insist(checks, "unsupported_admission_checks");
  insist(
    hashJson(r.checks) === hashJson(checks),
    "unsupported_admission_checks",
  );
  const d = object(r.declared);
  exact(d, ["songSha256", "titleSha256", "lyricsSha256"]);
  insist(
    d.songSha256 === song.sha256 &&
      d.titleSha256 === title.sha256 &&
      d.lyricsSha256 === (lyrics?.sha256 ?? null),
    "admission_declaration_mismatch",
  );
  return {
    jobId,
    submissionId,
    communityId: pairing.communityId,
    checks,
    inputs: { song, title, lyrics },
    declared: {
      songSha256: song.sha256,
      titleSha256: title.sha256,
      lyricsSha256: lyrics?.sha256 ?? null,
    },
  };
}
/** Expiring transport tokens may be renewed only for identical input paths,
 * digests and lengths. Wire authorization still signs the complete request. */
export function admissionInputHash(request: AdmissionRequest) {
  const semantic = (cap: Capability | null) =>
    cap
      ? {
          path: new URL(cap.url).origin + new URL(cap.url).pathname,
          sha256: cap.sha256,
          byteLength: cap.byteLength,
        }
      : null;
  return hashJson({
    ...request,
    inputs: {
      song: semantic(request.inputs.song),
      title: semantic(request.inputs.title),
      lyrics: semantic(request.inputs.lyrics),
    },
  });
}
export async function fetchCapability(
  cap: Capability,
  transport: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  insist(cap.expiresAt > nowSeconds, "media_capability_expired", 409);
  const response = await transport(
    new Request(cap.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "cache-control": "no-store" },
    }),
  );
  insist(response.ok && response.body, "private_input_unavailable", 503);
  const bytes = new Uint8Array(cap.byteLength),
    reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > bytes.length) {
        await reader.cancel();
        insist(false, "input_digest_mismatch", 409);
      }
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  insist(
    offset === bytes.length && sha256(bytes) === cap.sha256,
    "input_digest_mismatch",
    409,
  );
  return bytes;
}
