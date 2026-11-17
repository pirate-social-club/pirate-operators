import { sha256 } from "viem";
import { canonical, check } from "../packages/protocol/index.ts";
import {
  verifyPublicationPolicy,
  type PublicationPurpose,
} from "../packages/protocol/publication-consent.ts";
import { record } from "./publication-command-contract.ts";
import type { PublicationAppRelease } from "./publication-app-selection.ts";
import { PublicationRequestSession } from "./publication-app-request.ts";

/** Shared bounded byte reader; callers own a deadline and abort signal. */
export async function publicationResponseBytes(
  response: Response,
  maxBytes: number,
) {
  check(response.ok && response.body, "publication_response_unavailable");
  const length = response.headers.get("content-length");
  if (length !== null)
    check(
      /^(0|[1-9][0-9]*)(?![\s\S])/.test(length) && Number(length) <= maxBytes,
      "publication_response_too_large",
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      check(size <= maxBytes, "publication_response_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
/** Downloads exact UTF-8 bytes from installed URLs. No redirect, normalized
 * HTML, policy inference or reconstructed hash is accepted. */
export async function publicationDocuments(
  release: PublicationAppRelease,
  purpose: PublicationPurpose,
  session: PublicationRequestSession,
  timeoutMs: number,
  maxDocumentBytes: number,
) {
  check(
    session instanceof PublicationRequestSession &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 30000 &&
      Number.isSafeInteger(maxDocumentBytes) &&
      maxDocumentBytes > 0 &&
      maxDocumentBytes <= 262144,
    "publication_document_bounds_invalid",
  );
  const selected = release.policies[purpose];
  check(selected, "publication_purpose_disabled");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  const documents: Record<string, string> = {},
    hashes: Record<string, string> = {};
  try {
    for (const key of [
      "manifest",
      "terms",
      "disclosure",
      "privacy",
      "retention",
    ] as const) {
      await session.check();
      const response = await fetch(selected.documents[key], {
        redirect: "error",
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      await session.check();
      const bytes = await publicationResponseBytes(response, maxDocumentBytes);
      await session.check();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // Reject BOM stripping or any byte representation not preserved for display.
      check(
        sha256(new TextEncoder().encode(text)) === sha256(bytes),
        "publication_document_encoding_changed",
      );
      documents[key] = text;
      hashes[key] = sha256(bytes);
    }
    const manifest = record(JSON.parse(documents.manifest!));
    check(
      canonical(manifest) === documents.manifest &&
        hashes.manifest === selected.policyHash,
      "publication_policy_bytes_changed",
    );
    for (const key of ["terms", "disclosure", "privacy", "retention"])
      check(
        manifest[key + "Sha256"] === hashes[key],
        "publication_document_bytes_changed",
      );
    const policy = verifyPublicationPolicy(manifest, {
      purpose,
      policyHash: selected.policyHash,
      maxGrantDurationSeconds: BigInt(selected.maxGrantDurationSeconds),
      maxSubmissionDelaySeconds: BigInt(selected.maxSubmissionDelaySeconds),
      dancePublicityPolicyHash: selected.dancePublicityPolicyHash,
    });
    await session.check();
    return { documents, policyHash: policy.policyHash };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
