import type { Address, Hex } from "viem";
import {
  canonical,
  exact,
  hashText,
  insist,
  integer,
  object,
} from "../community/common.ts";
import {
  evidenceId,
  recoverEvidence,
  validateEvidence,
  type EvidenceCheck,
  type EvidenceRecord,
} from "./evidence.ts";

export interface AudioWindowFacts {
  role: "primary" | "alternate";
  firstFrame: number;
  frameCount: number;
  startMs: number;
  durationMs: number;
  sampleSha256: Hex;
}
export interface AdmissionFacts {
  communityId: Hex;
  submissionId: string;
  jobId: string;
  songSha256: Hex;
  songByteLength: number;
  title: string;
  lyrics: string;
  songType: "original" | "other";
  declaredRating: "general" | "adult_18";
  windows: AudioWindowFacts[];
  providerEndpoint: string;
}
export interface AdmissionPolicy {
  operators: Address[];
  maxAgeSeconds: number;
}
export interface AdmissionDecision {
  decision: "publish" | "block" | "hold" | "needs_evidence";
  rating: "general" | "adult_18" | null;
  coverDisplayed: false;
  used: Hex[];
  missing: EvidenceCheck[];
  reasons: string[];
}
function boundAudio(record: EvidenceRecord, facts: AdmissionFacts) {
  const input = record.inputs;
  exact(input, [
    "songSha256",
    "songByteLength",
    "extraction",
    "windows",
    "provider",
    "providerEndpoint",
  ]);
  insist(
    input.songSha256 === facts.songSha256 &&
      input.songByteLength === facts.songByteLength &&
      input.extraction === "mp3-frame-window/1" &&
      input.provider === "acrcloud" &&
      input.providerEndpoint === facts.providerEndpoint,
    "audio_evidence_input_mismatch",
  );
  insist(
    Array.isArray(input.windows) &&
      input.windows.length >= 1 &&
      input.windows.length <= 2,
    "invalid_audio_evidence_windows",
  );
  const codes = input.windows.map((value, index) => {
    const window = object(value);
    exact(window, [
      "role",
      "firstFrame",
      "frameCount",
      "startMs",
      "durationMs",
      "sampleSha256",
      "providerCode",
    ]);
    const expected = facts.windows.find(
      (w) => w.role === (index === 0 ? "primary" : "alternate"),
    );
    insist(expected, "missing_current_audio_window");
    const { providerCode, ...current } = window;
    insist(
      canonical(current) === canonical(expected),
      "audio_window_input_mismatch",
    );
    return integer(providerCode, 0, 10000);
  });
  insist(
    codes.every((code) => [0, 1001, 2004].includes(code)) &&
      (codes.length === 1 || codes[0] === 1001 || codes[0] === 2004),
    "invalid_audio_provider_codes",
  );
  const result = codes.includes(0)
    ? "identified"
    : codes.every((code) => code === 1001)
      ? "not_identified"
      : "inconclusive";
  insist(
    record.envelope.result === result &&
      (codes[0] !== 2004 || codes.length === 2),
    "audio_result_mismatch",
  );
}
function boundText(record: EvidenceRecord, facts: AdmissionFacts) {
  if (record.envelope.check === "title.rating") {
    exact(record.inputs, ["titleRevision", "titleSha256"]);
    insist(
      record.inputs.titleRevision === 1 &&
        record.inputs.titleSha256 === hashText(facts.title),
      "title_evidence_input_mismatch",
    );
  } else {
    exact(record.inputs, ["lyricsRevision", "lyricsSha256"]);
    insist(
      record.inputs.lyricsRevision === 1 &&
        record.inputs.lyricsSha256 === hashText(facts.lyrics),
      "lyrics_evidence_input_mismatch",
    );
    insist(
      typeof record.details.explicit === "boolean" &&
        typeof record.details.primaryLanguage === "string" &&
        /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(
          record.details.primaryLanguage,
        ),
      "missing_lyrics_classification",
    );
  }
  insist(
    record.envelope.result === "general" ||
      record.envelope.result === "adult_18",
    "invalid_text_rating",
  );
}
/** Cryptographic/body/input verification precedes the deterministic release gate. */
export async function verifyAdmission(
  facts: AdmissionFacts,
  values: unknown[],
  policy: AdmissionPolicy,
  nowSeconds: number,
): Promise<AdmissionDecision> {
  integer(nowSeconds, 1, Number.MAX_SAFE_INTEGER);
  integer(policy.maxAgeSeconds, 1, 86400);
  insist(
    values.length <= 32 && facts.windows.length <= 2,
    "too_many_evidence_records",
  );
  const required: EvidenceCheck[] = [
    "audio.identification",
    "title.rating",
    ...(facts.lyrics.trim() ? ["lyrics.classification" as const] : []),
  ];
  const valid: EvidenceRecord[] = [];
  for (const value of values) {
    try {
      const record = validateEvidence(value),
        e = record.envelope;
      insist(
        required.includes(e.check) &&
          policy.operators.some((o) => o.toLowerCase() === e.operator),
        "untrusted_evidence_operator",
      );
      insist(
        (await recoverEvidence(record)) === e.operator,
        "invalid_evidence_signature",
      );
      insist(
        e.communityId === facts.communityId &&
          e.submissionId === facts.submissionId &&
          e.jobId === facts.jobId,
        "evidence_scope_mismatch",
      );
      insist(
        e.issuedAt <= nowSeconds &&
          e.expiresAt > nowSeconds &&
          nowSeconds - e.issuedAt <= policy.maxAgeSeconds,
        "expired_evidence",
      );
      const subject =
        e.check === "audio.identification"
          ? facts.songSha256
          : hashText(e.check === "title.rating" ? facts.title : facts.lyrics);
      insist(e.subject === subject, "evidence_subject_mismatch");
      if (e.check === "audio.identification") boundAudio(record, facts);
      else boundText(record, facts);
      valid.push(record);
    } catch {
      /* Invalid records never satisfy a required check. */
    }
  }
  const missing = required.filter(
    (check) => !valid.some((r) => r.envelope.check === check),
  );
  const base = {
    coverDisplayed: false as const,
    used: [] as Hex[],
    missing,
    rating: null,
  };
  if (missing.length)
    return {
      ...base,
      decision: "needs_evidence",
      reasons: ["required_evidence_missing"],
    };
  for (const check of required) {
    const records = valid.filter((r) => r.envelope.check === check);
    if (new Set(records.map((r) => r.envelope.result)).size > 1)
      return {
        ...base,
        decision: "hold",
        reasons: ["trusted_operators_disagree"],
      };
  }
  const selected = required.map(
    (check) =>
      valid
        .filter((r) => r.envelope.check === check)
        .sort(
          (a, b) =>
            b.envelope.issuedAt - a.envelope.issuedAt ||
            evidenceId(a.envelope).localeCompare(evidenceId(b.envelope)),
        )[0]!,
  );
  const used = selected.map((r) => evidenceId(r.envelope)),
    audio = selected[0]!.envelope.result;
  if (audio === "identified")
    return {
      ...base,
      used,
      decision: "block",
      reasons: ["reference_audio_identified"],
    };
  if (audio !== "not_identified" || facts.songType !== "original")
    return {
      ...base,
      used,
      decision: "hold",
      reasons: ["audio_admission_unresolved"],
    };
  // Explicit lyrics alone are allowed. A text check can raise the public
  // rating, but cannot silently replace the release policy with a rejection.
  const rating =
    facts.declaredRating === "adult_18" ||
    selected.some((r) => r.envelope.result === "adult_18")
      ? "adult_18"
      : "general";
  return { ...base, used, decision: "publish", rating, reasons: [] };
}
