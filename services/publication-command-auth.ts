import { recoverMessageAddress, sha256, type Address, type Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import type { ConsentSourceV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { exact, record } from "./publication-command-contract.ts";

export interface PublicationIssuerV1 {
  source: ConsentSourceV1;
  issuer: Address;
  operator: Address;
}
const paths = ["/publication/v1/fence", "/publication/v1/accept",
  "/publication/v1/reconcile"] as const;
async function bytes(request: Request) {
  check(request.body, "publication_body_required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      check(size <= 32768, "publication_request_too_large");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
/** Trusted expected source is loaded by Root's route, never from HTTP input.
 * This authenticates the issuer's transport, not learner consent. */
export async function publicationIssuerBody(
  request: Request, expected: PublicationIssuerV1, clock: () => number,
): Promise<unknown> {
  const nowS = clock();
  check(Number.isSafeInteger(nowS) && nowS > 0, "publication_clock_invalid");
  const path = new URL(request.url).pathname;
  check(request.method === "POST" && paths.some(p => p === path), "publication_route_invalid");
  const header = request.headers.get("x-pirate-publication-authorization");
  check(header && header.length <= 4096, "publication_issuer_required");
  const signed = record(JSON.parse(header)); exact(signed, ["request", "signature"]);
  const a = record(signed.request);
  exact(a, ["schema", "method", "path", "chainId", "communityId", "installationId",
    "sourceSha256", "operator", "issuedAt", "expiresAt", "bodyHash", "commandId", "nonce"]);
  check(a.schema === "pirate.publication.operator-request/1" && a.method === "POST" &&
    a.path === path && a.chainId === expected.source.chainId &&
    (a.chainId === 31337 || a.chainId === 6343) &&
    a.communityId === expected.source.communityId &&
    a.installationId === expected.source.installationId &&
    a.sourceSha256 === digest(expected.source) && a.operator === expected.operator &&
    typeof a.commandId === "string" && /^0x[0-9a-f]{64}(?![\s\S])/.test(a.commandId) &&
    BigInt(a.commandId) !== 0n &&
    typeof a.nonce === "string" && /^0x[0-9a-f]{64}(?![\s\S])/.test(a.nonce) &&
    BigInt(a.nonce) !== 0n &&
    typeof a.issuedAt === "number" && Number.isSafeInteger(a.issuedAt) &&
    typeof a.expiresAt === "number" && Number.isSafeInteger(a.expiresAt) &&
    a.issuedAt > 0 && a.issuedAt <= nowS + 5 && a.expiresAt - a.issuedAt === 60 &&
    nowS < a.expiresAt && typeof a.bodyHash === "string" &&
    /^0x[0-9a-f]{64}(?![\s\S])/.test(a.bodyHash) && typeof signed.signature === "string" &&
    /^0x[0-9a-f]{130}(?![\s\S])/.test(signed.signature), "publication_issuer_invalid");
  const signer = await recoverMessageAddress({message: canonical(a),
    signature: signed.signature as Hex});
  check(signer.toLowerCase() === expected.issuer.toLowerCase(), "publication_issuer_invalid");
  const raw = await bytes(request);
  check(sha256(raw) === a.bodyHash, "publication_body_changed");
  const text = new TextDecoder("utf-8", {fatal: true}).decode(raw);
  const body: unknown = JSON.parse(text);
  check(canonical(body) === text, "publication_body_not_canonical");
  const b = record(body);
  const id = path === "/publication/v1/accept" ? record(b.command).commandId : b.commandId;
  check(id === a.commandId, "publication_issuer_command_changed");
  const ended = clock();
  check(Number.isSafeInteger(ended) && ended >= nowS && ended < (a.expiresAt as number),
    "publication_issuer_expired");
  return body;
}
