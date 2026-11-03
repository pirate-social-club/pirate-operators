import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CONTEXT, MAX_BYTES, object, queryFor } from "./proof.ts";

const BRIDGE = "https://bridge.very.org/api/v1";
const VERIFIER = "https://verify.very.org/api/v1/verify";
export type Envelope = { iv: string; payload: string };
export type Session = { id: string };
export interface Provider {
  open(
    appId: string,
    scope: string,
    binding: string,
    key: Buffer,
  ): Promise<Session>;
  poll(session: Session, key: Buffer): Promise<string | null>;
  verify(proof: string): Promise<void>;
}

export function encrypt(text: string, key: Buffer): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv: iv.toString("base64"), payload: encrypted.toString("base64") };
}

function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > MAX_BYTES * 2)
    throw new Error("invalid_envelope");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid_envelope");
  return bytes;
}

export function decrypt(value: unknown, key: Buffer): string {
  const envelope = object(value);
  const iv = base64(envelope.iv);
  const payload = base64(envelope.payload);
  if (iv.length !== 12 || payload.length < 16 || payload.length > MAX_BYTES)
    throw new Error("invalid_envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(payload.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(payload.subarray(0, -16)),
    decipher.final(),
  ]);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } finally {
    plain.fill(0);
  }
}

// Injection is for offline tests only. The CLI never accepts endpoint overrides.
export function hostedProvider(fetcher: typeof fetch = fetch): Provider {
  async function request(
    url: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) throw new Error();
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error();
        chunks.push(part.value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      // Never surface provider bodies, handles, URLs or proof-bearing errors.
      throw new Error("provider_unavailable_or_invalid");
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
  return {
    async open(appId, scope, binding, key) {
      const launch = {
        appId,
        idpContext: CONTEXT,
        idpTypeId: "3",
        idpQuery: JSON.stringify(queryFor(scope, binding)),
      };
      const result = await request(
        `${BRIDGE}/sessions`,
        encrypt(JSON.stringify(launch), key),
      );
      if (
        typeof result.sessionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(result.sessionId)
      )
        throw new Error("invalid_session");
      return { id: result.sessionId };
    },
    async poll(session, key) {
      const result = await request(
        `${BRIDGE}/session/${encodeURIComponent(session.id)}`,
      );
      if (["pending", "received", "processing"].includes(String(result.status)))
        return null;
      if (result.status !== "completed") throw new Error("bridge_failed");
      return decrypt(result.response, key);
    },
    async verify(proof) {
      const result = await request(VERIFIER, { proof });
      if (result.status !== "valid") throw new Error("verifier_rejected");
    },
  };
}
