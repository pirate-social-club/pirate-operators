import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { Files } from "files-sdk/effect";
import { createObjectStorage } from "../packages/storage/files.ts";
import { interceptStorage } from "./helpers/storage-s3-protocol.ts";

const credentials = {
  accessKeyId: "fixture-access-key",
  secretAccessKey: "fixture-secret-key-never-real",
};
const backup = { version: 1, role: "backup", bucket: "community-backups" };
const profiles = [
  backup,
  { ...backup, provider: "b2", region: "us-west-004" },
  {
    ...backup,
    provider: "s3",
    endpoint: "https://storage.example",
    region: "local",
  },
];

test("object factory requires separate explicit credentials and refuses the pinning role", () => {
  assert.throws(
    () => createObjectStorage({ version: 1, role: "public-ipfs" }, credentials),
    /storage_ipfs_requires_pinning_flow/,
  );
  for (const value of [
    undefined,
    null,
    {},
    { accessKeyId: "x" },
    { ...credentials, accessKeyId: "" },
    { ...credentials, secretAccessKey: "\n" },
    { ...credentials, token: "fixture-pinning-token" },
  ])
    assert.throws(
      () => createObjectStorage(backup, value),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^storage_credentials_/);
        assert.ok(!error.message.includes("fixture-"));
        return true;
      },
    );
});

test("all native adapters sign, upload, stream, delete and map absence through Effect", async () => {
  for (const profile of profiles) {
    const storage = createObjectStorage(profile, credentials);
    const fixture = interceptStorage(storage);
    try {
      const input = new TextEncoder().encode("private object fixture\n");
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const files = yield* Files;
          assert.equal(files.capabilities.publicUrl, false);
          const uploaded = yield* files.upload(
            "private/object with space.bin",
            input,
            { contentType: "application/octet-stream" },
          );
          const head = yield* files.head(uploaded.key);
          const body = yield* files.download(uploaded.key);
          const chunks = yield* Stream.runCollect(body.stream);
          yield* files.delete(uploaded.key);
          const exists = yield* files.exists(uploaded.key);
          const missing = yield* files.download(uploaded.key).pipe(
            Effect.match({
              onSuccess: () => "unexpected-success",
              onFailure: (error) => error.reason._tag,
            }),
          );
          return { uploaded, head, chunks, exists, missing };
        }).pipe(Effect.provide(storage.layer)),
      );
      assert.equal(result.uploaded.size, input.length);
      assert.equal(result.head.size, input.length);
      assert.deepEqual(
        Buffer.concat(Array.from(result.chunks)),
        Buffer.from(input),
      );
      assert.equal(result.exists, false);
      assert.equal(result.missing, "NotFound");
      assert.deepEqual(
        fixture.requests.map((r) => r.method),
        ["PUT", "HEAD", "GET", "DELETE", "HEAD", "GET"],
      );
      assert.equal(fixture.objects.size, 0);
      assert.ok(
        !JSON.stringify(storage.profile).includes(credentials.secretAccessKey),
      );
    } finally {
      storage.close();
    }
    assert.equal(fixture.isDestroyed(), true);
  }
});

test("unknown-length stream uses real multipart and preserves bytes through Effect", async () => {
  const storage = createObjectStorage(backup, credentials);
  const fixture = interceptStorage(storage);
  try {
    // More than one minimum S3 part, deliberately without a content length.
    const input = Buffer.alloc(6 * 1024 * 1024 + 17, 0x5a);
    input[0] = 0x01;
    input[input.length - 1] = 0x02;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === input.length) return controller.close();
        const next = Math.min(offset + 65536, input.length);
        controller.enqueue(input.subarray(offset, next));
        offset = next;
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const files = yield* Files;
        const uploaded = yield* files.upload("synthetic-backup.bin", body, {
          contentType: "application/octet-stream",
          multipart: { partSize: 5 * 1024 * 1024, concurrency: 1 },
        });
        const downloaded = yield* files.download(uploaded.key);
        const chunks = yield* Stream.runCollect(downloaded.stream);
        return { uploaded, chunks };
      }).pipe(Effect.provide(storage.layer)),
    );
    assert.equal(result.uploaded.size, input.length);
    assert.equal(fixture.parts.size, 2);
    assert.deepEqual(
      fixture.requests.map((r) => r.operation),
      ["create", "part", "part", "complete", "object", "object"],
    );
    assert.deepEqual(Buffer.concat(Array.from(result.chunks)), input);
  } finally {
    storage.close();
  }
});

test("custom endpoints retain unsupported conditional writes without a provider request", async () => {
  const storage = createObjectStorage(profiles[2], credentials);
  const fixture = interceptStorage(storage);
  try {
    const reason = await Effect.runPromise(
      Effect.gen(function* () {
        const files = yield* Files;
        return yield* files
          .upload("backup.age", "fixture", { condition: { type: "create" } })
          .pipe(
            Effect.match({
              onSuccess: () => "unexpected-success",
              onFailure: (error) => error.reason._tag,
            }),
          );
      }).pipe(Effect.provide(storage.layer)),
    );
    assert.equal(reason, "Unsupported");
    assert.equal(fixture.requests.length, 0);
  } finally {
    storage.close();
  }
});
