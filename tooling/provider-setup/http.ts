import { requireThat, SetupFailure, type Vault, type Plan } from "./model.ts";
import type { Store } from "./journal.ts";
import { validCredential } from "./private-input.ts";

export type Transport = (request: Request) => Promise<Response>;
export async function bounded(response: Response, limit: number) {
  requireThat(response.body, "response_body_missing");
  const chunks: Uint8Array[] = [],
    reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new SetupFailure("provider_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export class Context {
  requests = 0;
  readonly store: Store;
  readonly vault: Vault;
  readonly send: Transport;
  readonly signal: AbortSignal;
  constructor(
    store: Store,
    vault: Vault,
    send: Transport = (request) => fetch(request),
    signal: AbortSignal = new AbortController().signal,
  ) {
    this.store = store;
    this.vault = vault;
    this.send = send;
    this.signal = signal;
  }
  get plan(): Plan {
    requireThat(this.store.journal, "journal_missing");
    return this.store.journal.plan;
  }
  async secret(zone: "bootstrap" | "runtime", name: string) {
    const value = await this.vault.get(zone, name);
    requireThat(validCredential(value), `missing_${name.toLowerCase()}`);
    return value;
  }
  async request(url: string, init: RequestInit = {}) {
    const target = new URL(url);
    requireThat(
      [
        "https://api-v2.acrcloud.com",
        "https://api.openai.com",
        "https://gateway.pinata.cloud",
        "https://rpc.filebase.io",
        ...["eu-west-1", "us-west-2", "ap-southeast-1"].map(
          (r) => `https://identify-${r}.acrcloud.com`,
        ),
      ].includes(target.origin),
      "unapproved_provider_origin",
    );
    requireThat(++this.requests <= 64, "request_bound_exceeded");
    try {
      return await this.send(
        new Request(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
        }),
      );
    } catch {
      throw new SetupFailure("provider_request_uncertain");
    }
  }
  async json(url: string, init: RequestInit = {}) {
    const response = await this.request(url, init);
    requireThat(response.ok, `provider_http_${response.status}`);
    try {
      return JSON.parse((await bounded(response, 1024 * 1024)).toString());
    } catch (error) {
      if (error instanceof SetupFailure) throw error;
      throw new SetupFailure("provider_json_invalid");
    }
  }
}
