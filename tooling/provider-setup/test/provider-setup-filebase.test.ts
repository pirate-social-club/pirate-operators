import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CarReader } from "@ipld/car";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { Context } from "../http.ts";
import {
  filebaseClient,
  provisionFilebase,
  qualifyFilebase,
} from "../filebase.ts";
import { memoryVault, state } from "./provider-setup-fixtures.ts";

async function fixture() {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("FILEBASE_ACCESS_KEY_ID", "filebase-setup-access");
  vault.bootstrap.set("FILEBASE_SECRET_ACCESS_KEY", "filebase-setup-secret");
  const recorded: {
    method: string;
    path: string;
    headers: Record<string, string>;
  }[] = [];
  const db = {
    buckets: [] as string[],
    creates: 0,
    puts: 0,
    metadata: {} as Record<string, string>,
    publicBytes: undefined as Uint8Array | undefined,
    loseCreate: false,
    losePut: false,
    gatewayDown: false,
  };
  const handler = {
    async handle(request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      hostname: string;
      body?: Uint8Array;
    }) {
      assert.equal(request.hostname, "s3.filebase.com");
      assert.match(
        request.headers.authorization,
        /^AWS4-HMAC-SHA256 Credential=filebase-setup-access\/\d{8}\/us-east-1\/s3\/aws4_request,/,
      );
      recorded.push({
        method: request.method,
        path: request.path,
        headers: request.headers,
      });
      const response = (statusCode: number, body = "", headers = {}) => ({
        response: { statusCode, headers, body: Readable.from([body]) },
      });
      if (request.method === "GET" && request.path === "/")
        return response(
          200,
          `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets>${db.buckets.map((Name) => `<Bucket><Name>${Name}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`,
        );
      if (request.method === "PUT" && !request.path.includes("/setup/")) {
        db.creates++;
        db.buckets.push(store.journal!.plan.names.filebase);
        if (db.loseCreate) {
          db.loseCreate = false;
          throw Error("secret-bearing response lost");
        }
        return response(200);
      }
      if (request.method === "HEAD")
        return db.publicBytes ? response(200, "", db.metadata) : response(404);
      assert.equal(request.method, "PUT");
      db.puts++;
      assert.equal(request.headers["x-amz-meta-import"], "car");
      const reader = await CarReader.fromBytes(new Uint8Array(request.body!)),
        [root] = await reader.getRoots();
      db.publicBytes = (await reader.get(root))!.bytes;
      db.metadata = {
        "x-amz-meta-cid": root.toString(),
        "x-amz-meta-intent": request.headers["x-amz-meta-intent"],
        "x-amz-meta-sha256": request.headers["x-amz-meta-sha256"],
      };
      if (db.losePut) {
        db.losePut = false;
        throw Error("lost upload response");
      }
      return response(200);
    },
    destroy() {},
  } as unknown as S3ClientConfig["requestHandler"];
  const ctx = new Context(store, vault, async (request) => {
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(new URL(request.url).hostname, "gateway.pinata.cloud");
    return db.gatewayDown
      ? new Response("rate limited", { status: 429 })
      : new Response(new Uint8Array(db.publicBytes!));
  });
  const client = await filebaseClient(ctx, handler);
  return { store, vault, ctx, client, db, recorded };
}
test("Filebase uses signed IPFS requests, imports a CAR with its exact root and verifies independent public bytes", async () => {
  const f = await fixture();
  try {
    await provisionFilebase(f.ctx, f.client);
    await qualifyFilebase(f.ctx, f.client);
    await provisionFilebase(f.ctx, f.client);
    await qualifyFilebase(f.ctx, f.client);
    assert.equal(f.db.creates, 1);
    assert.equal(f.db.puts, 1);
    assert.equal(f.vault.runtime.size, 0);
    assert.equal(
      f.store.journal!.steps["filebase.retrieval"].receipt!.passed,
      true,
    );
    const disk = await readFile(
      join(f.store.directory, "journal.json"),
      "utf8",
    );
    assert(
      !disk.includes("filebase-setup-secret") &&
        !disk.includes("filebase-setup-access"),
    );
    assert(!f.recorded.some((r) => r.method === "DELETE"));
  } finally {
    f.client.destroy();
  }
});
test("a Filebase account containing other buckets is refused before resource creation", async () => {
  const f = await fixture();
  f.db.buckets.push("existing-private-bucket");
  try {
    await assert.rejects(
      provisionFilebase(f.ctx, f.client),
      /contains_other_buckets/,
    );
    assert.equal(f.db.creates, 0);
    assert.equal(f.db.puts, 0);
    assert(
      !JSON.stringify(f.store.summary()).includes("existing-private-bucket"),
    );
  } finally {
    f.client.destroy();
  }
});
test("lost Filebase create and upload responses reconcile without repeating either write", async () => {
  const f = await fixture();
  f.db.loseCreate = true;
  f.db.losePut = true;
  try {
    await assert.rejects(provisionFilebase(f.ctx, f.client));
    await provisionFilebase(f.ctx, f.client);
    await assert.rejects(qualifyFilebase(f.ctx, f.client));
    await qualifyFilebase(f.ctx, f.client);
    assert.equal(f.db.creates, 1);
    assert.equal(f.db.puts, 1);
  } finally {
    f.client.destroy();
  }
});
test("gateway failures retry retrieval only and keep the successful original pin receipt", async () => {
  const f = await fixture();
  f.db.gatewayDown = true;
  try {
    await provisionFilebase(f.ctx, f.client);
    await assert.rejects(
      qualifyFilebase(f.ctx, f.client),
      /gateway_unavailable/,
    );
    const receipt = f.store.journal!.steps["filebase.upload"].receipt;
    f.db.gatewayDown = false;
    await qualifyFilebase(f.ctx, f.client);
    assert.equal(f.db.puts, 1);
    assert.deepEqual(
      f.store.journal!.steps["filebase.upload"].receipt,
      receipt,
    );
  } finally {
    f.client.destroy();
  }
});
test("changing Filebase credentials cannot redirect a resumed intent to another account", async () => {
  const f = await fixture();
  await provisionFilebase(f.ctx, f.client);
  f.vault.bootstrap.set("FILEBASE_ACCESS_KEY_ID", "another-account-access");
  try {
    await assert.rejects(filebaseClient(f.ctx), /account_changed/);
  } finally {
    f.client.destroy();
  }
});
test("independent retrieval retries have a durable bound and cannot cause another upload", async () => {
  const f = await fixture();
  f.db.gatewayDown = true;
  try {
    await provisionFilebase(f.ctx, f.client);
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        qualifyFilebase(f.ctx, f.client),
        /gateway_unavailable/,
      );
    await assert.rejects(
      qualifyFilebase(f.ctx, f.client),
      /attempts_exhausted/,
    );
    assert.equal(f.db.puts, 1);
  } finally {
    f.client.destroy();
  }
});
