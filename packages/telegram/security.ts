import { telegramCheck } from "./contracts.ts";

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export function decodeBase64url(value: string): Uint8Array {
  telegramCheck(
    /^[A-Za-z0-9_-]+$/.test(value) && value.length < 32_768,
    "telegram_encoding_invalid",
  );
  try {
    return Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new Error("telegram_encoding_invalid");
  }
}
export const randomToken = () =>
  base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(value: string | Uint8Array): Promise<string> {
  const input =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
  );
}
export async function equalSecret(a: string, b: string) {
  if (a.length > 4096 || b.length > 4096) return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++)
    difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
export function httpsOrigin(value: string) {
  const url = new URL(value);
  telegramCheck(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === value,
    "telegram_origin_invalid",
  );
  return url.origin;
}
export function exactReturn(value: string) {
  const url = new URL(value);
  httpsOrigin(url.origin);
  telegramCheck(!url.search && !url.hash, "telegram_return_invalid");
  return url.href;
}
export function cookie(request: Request, name: string): string {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  telegramCheck(matches.length === 1, "telegram_browser_mismatch", 403);
  const value = matches[0].slice(name.length + 1);
  telegramCheck(
    /^[A-Za-z0-9_-]{43}$/.test(value),
    "telegram_browser_mismatch",
    403,
  );
  return value;
}
export const browserCookie = (name: string, value: string) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`;
export const privateHeaders = () => ({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});
export async function readJson(
  request: Pick<Request, "headers" | "body">,
  maxBytes = 65_536,
): Promise<unknown> {
  telegramCheck(
    Number(request.headers.get("content-length") ?? 0) <= maxBytes,
    "telegram_body_too_large",
    413,
  );
  telegramCheck(request.body, "telegram_body_required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      telegramCheck(size <= maxBytes, "telegram_body_too_large", 413);
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("telegram_json_invalid");
  }
}
