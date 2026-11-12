// In-process S3 protocol fixture. Real SDK serialization/signing runs, but the
// request handler is replaced before any operation: no socket or provider call.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { createObjectStorage } from "../../packages/storage/files.ts";

type Storage = ReturnType<typeof createObjectStorage>;
interface Request {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}
interface ObjectValue {
  bytes: Buffer;
  contentType: string;
  etag: string;
}

async function bytesFrom(body: unknown): Promise<Buffer> {
  if (body === undefined) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  assert.ok(body && typeof body === "object" && Symbol.asyncIterator in body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function interceptStorage(storage: Storage) {
  const objects = new Map<string, ObjectValue>();
  const parts = new Map<number, Buffer>();
  const requests: { method: string; key: string; operation: string }[] = [];
  let contentType = "application/octet-stream";
  let destroyed = false;
  const etag = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
  const response = (
    statusCode: number,
    headers: Record<string, string> = {},
    body: string | Buffer = "",
  ) => ({
    response: { statusCode, headers, body: Readable.from([Buffer.from(body)]) },
  });
  storage.client.raw.config.requestHandler = {
    async handle(request: Request) {
      assert.equal(destroyed, false);
      const { profile } = storage;
      const origin = new URL(profile.endpoint);
      const virtual = !profile.forcePathStyle;
      assert.equal(
        request.hostname,
        virtual ? `${profile.bucket}.${origin.hostname}` : origin.hostname,
      );
      assert.match(
        request.headers.authorization,
        new RegExp(`/` + profile.region + `/s3/aws4_request`),
      );
      const path = decodeURIComponent(request.path);
      const prefix = virtual ? "/" : `/${profile.bucket}/`;
      assert.ok(path.startsWith(prefix));
      const key = path.slice(prefix.length);
      const query = request.query ?? {};
      const operation =
        "uploads" in query
          ? "create"
          : "partNumber" in query
            ? "part"
            : "uploadId" in query
              ? "complete"
              : "object";
      requests.push({ method: request.method, key, operation });
      if (request.method === "POST" && operation === "create") {
        contentType = request.headers["content-type"] ?? contentType;
        return response(
          200,
          {},
          "<InitiateMultipartUploadResult><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (request.method === "PUT" && operation === "part") {
        assert.equal(query.uploadId, "fixture-upload");
        const bytes = await bytesFrom(request.body);
        parts.set(Number(query.partNumber), bytes);
        return response(200, { etag: `"${etag(bytes)}"` });
      }
      if (request.method === "POST" && operation === "complete") {
        assert.equal(query.uploadId, "fixture-upload");
        const xml = (await bytesFrom(request.body)).toString();
        const numbers = [
          ...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
        ].map((m) => Number(m[1]));
        assert.deepEqual(
          numbers,
          [...parts.keys()].sort((a, b) => a - b),
        );
        const bytes = Buffer.concat(numbers.map((n) => parts.get(n)!));
        const hash = etag(bytes);
        objects.set(key, { bytes, contentType, etag: hash });
        return response(
          200,
          {},
          `<CompleteMultipartUploadResult><ETag>"${hash}"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (request.method === "PUT" && operation === "object") {
        const bytes = await bytesFrom(request.body);
        const hash = etag(bytes);
        objects.set(key, {
          bytes,
          etag: hash,
          contentType: request.headers["content-type"] ?? contentType,
        });
        return response(200, { etag: `"${hash}"` });
      }
      if (request.method === "DELETE" && operation === "object") {
        objects.delete(key);
        return response(204);
      }
      const value = objects.get(key);
      if (!value)
        return response(404, {}, "<Error><Code>NoSuchKey</Code></Error>");
      const headers = {
        "content-length": String(value.bytes.length),
        "content-type": value.contentType,
        etag: `"${value.etag}"`,
        "last-modified": "Thu, 12 Nov 2026 00:00:00 GMT",
      };
      if (request.method === "HEAD") return response(200, headers);
      assert.equal(request.method, "GET");
      return response(200, headers, value.bytes);
    },
    destroy() {
      destroyed = true;
    },
  };
  // A fixture failure must surface directly, without retries or external I/O.
  storage.client.raw.config.maxAttempts = async () => 1;
  return { objects, parts, requests, isDestroyed: () => destroyed };
}
