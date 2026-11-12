import test from "node:test";
import assert from "node:assert/strict";
import { storageProfileFrom } from "../packages/community-setup/storage.ts";

const backup = { version: 1, role: "backup", bucket: "community-backups" };
const custom = {
  ...backup,
  provider: "s3",
  endpoint: "https://storage.example",
  region: "local",
};

test("public IPFS defaults to existing Filebase pinning without S3 settings", () => {
  const profile = storageProfileFrom({ version: 1, role: "public-ipfs" });
  assert.deepEqual(profile, {
    version: 1,
    role: "public-ipfs",
    provider: "filebase-ipfs",
  });
  assert.deepEqual(
    storageProfileFrom(JSON.parse(JSON.stringify(profile))),
    profile,
  );
  assert.throws(
    () => storageProfileFrom({ ...profile, bucket: "not-required" }),
    /storage_unknown_field/,
  );
});

test("private objects and backup destinations explicitly default to private Filebase", () => {
  for (const role of ["private-objects", "backup"]) {
    const profile = storageProfileFrom({ ...backup, role });
    assert.deepEqual(profile, {
      version: 1,
      role,
      provider: "filebase-private",
      bucket: "community-backups",
      endpoint: "https://s3.filebase.io",
      region: "auto",
      forcePathStyle: false,
    });
    assert.deepEqual(storageProfileFrom(profile), profile);
    for (const flag of ["connected", "deployed", "encrypted", "backupEnabled"])
      assert.throws(
        () => storageProfileFrom({ ...profile, [flag]: true }),
        /storage_unknown_field/,
      );
  }
});

test("explicit B2 and self-hosted choices survive normalization and round trip", () => {
  const b2 = storageProfileFrom({
    ...backup,
    provider: "b2",
    region: "us-west-004",
    forcePathStyle: true,
  });
  assert.equal(b2.provider, "b2");
  assert.ok("endpoint" in b2);
  assert.equal(b2.endpoint, "https://s3.us-west-004.backblazeb2.com");
  assert.equal(b2.forcePathStyle, true);
  assert.deepEqual(storageProfileFrom(b2), b2);
  const s3 = storageProfileFrom({
    ...custom,
    endpoint: "HTTPS://STORAGE.EXAMPLE:443/",
  });
  assert.ok("endpoint" in s3);
  assert.equal(s3.provider, "s3");
  assert.equal(s3.endpoint, "https://storage.example");
  assert.equal(s3.forcePathStyle, true);
  assert.deepEqual(storageProfileFrom(s3), s3);
  assert.equal(
    storageProfileFrom({ ...custom, endpoint: "http://127.0.0.1:9000/" })
      .provider,
    "s3",
  );
});

test("role and provider mismatches cannot turn object storage into IPFS pinning", () => {
  for (const provider of ["b2", "s3", "filebase-private"])
    assert.throws(
      () => storageProfileFrom({ version: 1, role: "public-ipfs", provider }),
      /storage_pinning_required/,
    );
  assert.throws(
    () => storageProfileFrom({ ...backup, provider: "filebase-ipfs" }),
    /storage_object_provider_required/,
  );
  for (const endpoint of [
    "https://s3.filebase.com",
    "https://s3.filebase.com.",
    "https://bucket.s3.filebase.com.",
  ])
    assert.throws(
      () => storageProfileFrom({ ...custom, endpoint }),
      /storage_public_backend_for_objects/,
    );
  assert.throws(
    () =>
      storageProfileFrom({ ...backup, endpoint: "https://s3.filebase.com" }),
    /storage_provider_endpoint/,
  );
  assert.throws(
    () => storageProfileFrom({ ...backup, region: "us-east-1" }),
    /storage_provider_region/,
  );
});

test("credentials and unknown fields are rejected without echoing values", () => {
  for (const field of [
    "accessKeyId",
    "secretAccessKey",
    "FILEBASE_IPFS_TOKEN",
    "credentials",
    "secretReferences",
    "publicBaseUrl",
  ]) {
    assert.throws(
      () => storageProfileFrom({ ...backup, [field]: "fixture-secret" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "storage_unknown_field");
        assert.ok(!error.message.includes("fixture-secret"));
        return true;
      },
    );
  }
});

test("endpoint validation rejects lossy normalization and credential-bearing URLs", () => {
  for (const endpoint of [
    "https://fixture-secret:password@storage.example",
    "https://storage.example/path",
    "https://storage.example/path/..",
    "https://storage.example?token=fixture-secret",
    "https://storage.example#x",
    "https://storage.example\\path",
    " https://storage.example",
    "https://storage.example%",
    "http://storage.example",
    "not-a-url",
  ]) {
    assert.throws(
      () => storageProfileFrom({ ...custom, endpoint }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^storage_endpoint_/);
        assert.ok(!error.message.includes(endpoint));
        return true;
      },
    );
  }
});

test("invalid versions, missing settings and malformed choices fail closed", () => {
  for (const value of [
    null,
    [],
    { ...backup, version: 2 },
    { ...backup, role: "unknown" },
    { version: 1, role: "public-ipfs", provider: null },
    { ...backup, provider: null },
    { ...backup, bucket: undefined },
    { ...backup, bucket: "BAD_BUCKET" },
    { ...backup, bucket: "bad..bucket" },
    { ...backup, provider: "b2" },
    { ...backup, provider: "s3", region: "local" },
    { ...custom, region: undefined },
    { ...custom, forcePathStyle: "true" },
    { ...custom, bucket: "dotted.bucket", forcePathStyle: false },
  ])
    assert.throws(() => storageProfileFrom(value), /^Error: storage_/);
});

test("trailing line terminators cannot bypass token or raw endpoint validation", () => {
  for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    for (const value of [
      { ...backup, bucket: "community-backups" + ending },
      { ...custom, region: "local" + ending },
      { ...custom, endpoint: "https://storage.example" + ending },
    ])
      assert.throws(() => storageProfileFrom(value), /^Error: storage_/);
  }
});
