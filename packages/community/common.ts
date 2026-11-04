import { canonical } from "../protocol/index.ts";
import { sha256, stringToHex, type Hex } from "viem";
import { timingSafeEqual } from "node:crypto";

export { canonical };
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export class CommunityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function insist(
  value: unknown,
  code: string,
  status = 400,
): asserts value {
  if (!value) throw new CommunityError(code, status);
}
export function object(value: unknown): Record<string, unknown> {
  insist(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_object",
  );
  insist(Object.getPrototypeOf(value) === Object.prototype, "invalid_object");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]) {
  insist(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "invalid_fields",
  );
}
export function text(value: unknown, max = 4096): string {
  insist(
    typeof value === "string" && value.length <= max && !value.includes("\0"),
    "invalid_text",
  );
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  insist(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    "invalid_integer",
  );
  return value;
}
export function bytes32(value: unknown): Hex {
  insist(
    typeof value === "string" &&
      /^0x[0-9a-f]{64}$/.test(value) &&
      !/^0x0+$/.test(value),
    "invalid_bytes32",
  );
  return value as Hex;
}
export function amount(value: unknown): bigint {
  insist(
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value),
    "invalid_amount",
  );
  return BigInt(value);
}
export function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export const publicId = (): Hex => `0x${token()}`;
export const hashText = (value: string): Hex => sha256(stringToHex(value));
export const hashJson = (value: unknown): Hex => hashText(canonical(value));
export const equalTokens = (a: string, b: string) =>
  timingSafeEqual(
    Buffer.from(hashText(a).slice(2), "hex"),
    Buffer.from(hashText(b).slice(2), "hex"),
  );
export const now = () => Date.now();
export async function jsonBody(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  insist(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "json_required",
    415,
  );
  const reader = request.body?.getReader();
  insist(reader, "body_required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new CommunityError("body_too_large", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof CommunityError) throw error;
    throw new CommunityError("invalid_json");
  }
}
export function requestOrigin(request: Request, expected: string) {
  insist(new URL(request.url).origin === expected, "wrong_host", 403);
  insist(request.headers.get("origin") === expected, "wrong_origin", 403);
  const site = request.headers.get("sec-fetch-site");
  insist(site === null || site === "same-origin", "cross_site_write", 403);
}
export const cookie = (value: string, maxAge = 30 * 86400) =>
  `__Host-community_session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
