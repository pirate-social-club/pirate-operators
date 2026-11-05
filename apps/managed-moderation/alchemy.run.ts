import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
// Same product repository, established encrypted state implementation.
// The packaging step copies these helpers beside this isolated stack.
import { encryptedLocalState } from "./encrypted-state.ts";

const prefix = "pirate-managed-firstsong-20261105";
export default Alchemy.Stack(
  prefix,
  { providers: Cloudflare.providers(), state: encryptedLocalState() },
  Effect.gen(function* () {
    const DB = yield* Cloudflare.D1.Database("Database", {
      name: `${prefix}-db`,
      migrations: "./migrations",
    });
    const MEDIA = yield* Cloudflare.R2.Bucket("Media", {
      name: `${prefix}-media`,
      publicAccess: false,
    });
    const JOBS = yield* Cloudflare.Queues.Queue("Jobs", {
      name: `${prefix}-jobs`,
    });
    const app = yield* Cloudflare.Worker("App", {
      name: prefix,
      main: "./worker/worker.mjs",
      bundle: false,
      compatibility: {
        date: "2026-11-04",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      workersDev: { enabled: true, previewsEnabled: false },
      crons: ["* * * * *"],
      limits: { cpuMs: 30000 },
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      env: {
        DB,
        MEDIA,
        JOBS,
        SERVICE_ORIGIN: process.env.SERVICE_ORIGIN!,
        SERVICE_PROFILE_HASH: process.env.SERVICE_PROFILE_HASH!,
        PAIRINGS_JSON: process.env.PAIRINGS_JSON!,
        DIRECTORY_PROFILES_JSON: process.env.DIRECTORY_PROFILES_JSON!,
        SERVICE_BUDGET_PERIOD: process.env.SERVICE_BUDGET_PERIOD!,
        SERVICE_REQUEST_CAP: process.env.SERVICE_REQUEST_CAP!,
        ACRCLOUD_HOST: process.env.ACRCLOUD_HOST!,
        RELEASE_GRANT_JSON: process.env.RELEASE_GRANT_JSON!,
        FILEBASE_IPFS_TOKEN: Config.Redacted("FILEBASE_IPFS_TOKEN"),
        REGISTRATION_OPERATOR_PRIVATE_KEY: Config.Redacted(
          "REGISTRATION_OPERATOR_PRIVATE_KEY",
        ),
        ACRCLOUD_ACCESS_KEY: Config.Redacted("ACRCLOUD_ACCESS_KEY"),
        ACRCLOUD_ACCESS_SECRET: Config.Redacted("ACRCLOUD_ACCESS_SECRET"),
        OPENAI_API_KEY: Config.Redacted("OPENAI_API_KEY"),
        MODERATION_SIGNER_PRIVATE_KEY: Config.Redacted(
          "MODERATION_SIGNER_PRIVATE_KEY",
        ),
      },
    });
    yield* Cloudflare.Queues.Consumer("Consumer", {
      queueId: JOBS.queueId,
      scriptName: app.workerName,
      settings: {
        batchSize: 1,
        maxConcurrency: 1,
        maxRetries: 3,
        maxWaitTimeMs: 1000,
        retryDelay: 60,
      },
    });
    return { origin: app.url, database: DB.databaseId, queue: JOBS.queueId };
  }),
);
