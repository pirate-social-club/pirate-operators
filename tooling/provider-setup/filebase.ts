import {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { canonical, digest, requireThat, SetupFailure } from "./model.ts";
import { Context, bounded } from "./http.ts";

const clientAccounts = new WeakMap<S3Client, string>();
export async function probeCar(intent: string) {
  const bytes = new TextEncoder().encode(
    canonical({
      schema: "pirate.public-setup-probe/1",
      intent,
      content: "Public onboarding test data.",
    }),
  );
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const { writer, out } = CarWriter.create([cid]);
  const result = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  await writer.put({ cid, bytes });
  await writer.close();
  return { bytes, cid: cid.toString(), car: await result };
}
export async function filebaseClient(
  ctx: Context,
  requestHandler?: S3ClientConfig["requestHandler"],
) {
  const accessKeyId = await ctx.secret("bootstrap", "FILEBASE_ACCESS_KEY_ID");
  const secretAccessKey = await ctx.secret(
    "bootstrap",
    "FILEBASE_SECRET_ACCESS_KEY",
  );
  const fingerprint = digest(accessKeyId);
  const account = ctx.store.journal?.steps["filebase.account"]?.receipt;
  requireThat(
    !account || account.fingerprint === fingerprint,
    "filebase_account_changed",
  );
  const client = new S3Client({
    endpoint: "https://s3.filebase.com",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    followRegionRedirects: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: requestHandler ?? {
      requestTimeout: 30_000,
      connectionTimeout: 10_000,
    },
  });
  clientAccounts.set(client, fingerprint);
  return client;
}
async function buckets(client: S3Client, ctx: Context) {
  const result = await client.send(new ListBucketsCommand({}), {
    abortSignal: ctx.signal,
  });
  const names = (result.Buckets ?? []).map((bucket) => bucket.Name);
  requireThat(
    names.every((name) => typeof name === "string") &&
      names.length <= 1 &&
      names.every((name) => name === ctx.plan.names.filebase),
    "filebase_account_contains_other_buckets",
  );
  return names;
}
export async function provisionFilebase(ctx: Context, client: S3Client) {
  const Bucket = ctx.plan.names.filebase;
  if (!ctx.store.journal?.steps["filebase.bucket"])
    requireThat(
      (await buckets(client, ctx)).length === 0,
      "filebase_bucket_already_exists",
    );
  const fingerprint = clientAccounts.get(client);
  requireThat(fingerprint, "unbound_filebase_client");
  const identity = async () => ({
    fingerprint,
    dedicatedAccountRequired: true,
  });
  const account = await ctx.store.once("filebase.account", identity, identity);
  requireThat(account.fingerprint === fingerprint, "filebase_account_changed");
  return ctx.store.once(
    "filebase.bucket",
    async () => {
      await client.send(new CreateBucketCommand({ Bucket }), {
        abortSignal: ctx.signal,
      });
      requireThat(
        (await buckets(client, ctx))[0] === Bucket,
        "filebase_bucket_not_confirmed",
      );
      return {
        bucket: Bucket,
        endpoint: "https://s3.filebase.com",
        region: "us-east-1",
      };
    },
    async () => {
      requireThat(
        (await buckets(client, ctx))[0] === Bucket,
        "filebase_create_uncertain_no_replacement",
      );
      return {
        bucket: Bucket,
        endpoint: "https://s3.filebase.com",
        region: "us-east-1",
      };
    },
  );
}
export async function qualifyFilebase(ctx: Context, client: S3Client) {
  requireThat(
    ctx.store.journal?.steps["filebase.bucket"]?.state === "done",
    "filebase_setup_required",
  );
  requireThat(
    (await buckets(client, ctx))[0] === ctx.plan.names.filebase,
    "filebase_bucket_not_confirmed",
  );
  const probe = await probeCar(ctx.plan.intent),
    Bucket = ctx.plan.names.filebase,
    Key = `setup/${ctx.plan.intent}.car`;
  const head = async () => {
    const result = await client.send(new HeadObjectCommand({ Bucket, Key }), {
      abortSignal: ctx.signal,
    });
    requireThat(
      result.Metadata?.cid === probe.cid &&
        result.Metadata?.intent === ctx.plan.intent &&
        result.Metadata?.sha256 === digest(probe.bytes),
      "filebase_pin_binding_mismatch",
    );
    return {
      bucket: Bucket,
      object: Key,
      cid: probe.cid,
      sha256: digest(probe.bytes),
      bytes: probe.bytes.length,
    };
  };
  await ctx.store.once(
    "filebase.upload",
    async () => {
      // Only a confirmed absence permits the single upload. Network/permission errors stop.
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key }), {
          abortSignal: ctx.signal,
        });
        throw new SetupFailure("filebase_probe_already_exists");
      } catch (error) {
        requireThat(
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404,
          "filebase_probe_absence_unconfirmed",
        );
      }
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: probe.car,
          ContentType: "application/vnd.ipld.car",
          Metadata: {
            import: "car",
            intent: ctx.plan.intent,
            sha256: digest(probe.bytes),
          },
        }),
        { abortSignal: ctx.signal },
      );
      return head();
    },
    head,
  );
  // Retrieval is read-only and can be retried. It never repeats the upload.
  await ctx.store.once(
    "filebase.retrieval",
    async () => retrieve(ctx, probe),
    async () => retrieve(ctx, probe),
  );
}
async function retrieve(
  ctx: Context,
  probe: Awaited<ReturnType<typeof probeCar>>,
) {
  const previous =
    ctx.store.journal?.steps["filebase.retrieval"].receipt?.attempts ?? 0;
  requireThat(
    typeof previous === "number" &&
      previous < ctx.plan.limits.independentRetrieval,
    "retrieval_attempts_exhausted",
  );
  const attempts = previous + 1;
  await ctx.store.note("filebase.retrieval", { attempts });
  const gateway = "https://gateway.pinata.cloud";
  const response = await ctx.request(`${gateway}/ipfs/${probe.cid}`, {
    headers: { "cache-control": "no-cache" },
  });
  requireThat(response.ok, "independent_gateway_unavailable");
  const bytes = await bounded(response, 4096);
  requireThat(
    bytes.length === probe.bytes.length &&
      digest(bytes) === digest(probe.bytes) &&
      CID.createV1(0x55, await sha256.digest(bytes)).toString() === probe.cid,
    "independent_retrieval_mismatch",
  );
  return {
    cid: probe.cid,
    sha256: digest(bytes),
    bytes: bytes.length,
    gateway,
    passed: true,
    attempts,
  };
}
