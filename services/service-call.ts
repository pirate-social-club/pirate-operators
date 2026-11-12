// Service-to-service helpers shared by every role, with no Workers-only
// imports, so the community application can use them under Node tests too.
import { check, supportedChain } from "../packages/protocol/index.ts";

export async function call<T>(
  binding: Fetcher,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await binding.fetch(`http://service${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as { error?: string } | null;
  check(response.ok, value?.error ?? `upstream_${response.status}`);
  return value as T;
}
export async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  check(text.length <= 32000, "request_too_large");
  return JSON.parse(text) as T;
}
export function signatureChainId(env: { SIGNATURE_CHAIN_ID?: string }) {
  return supportedChain(Number(env.SIGNATURE_CHAIN_ID ?? 31337));
}
