import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
// Same product repository, established encrypted state implementation.
// The packaging step copies these helpers beside this isolated stack.
import { encryptedLocalState } from "./encrypted-state.ts";

// Fresh packages select a separate encrypted stack explicitly. Historical
// identity, migrations, entrypoint and default bindings remain unchanged.
const selectedProfile = process.env.MANAGED_SERVICE_PACKAGE_PROFILE;
const helperOnly = selectedProfile === "operator-signing-only", fresh = selectedProfile === "managed-web2";
// A generated fresh package must never inherit the historical stack because
// its selector was omitted. Read only this package-local marker before either
// provider construction or encrypted state initialization; do not hide IO errors.
let packageBytes: Buffer | undefined;
try { packageBytes = readFileSync(new URL("./managed-web2-package.json", import.meta.url)); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
if (packageBytes !== undefined && !fresh && !helperOnly) throw new Error("managed_package_profile_required");
if (selectedProfile && !fresh && !helperOnly) throw new Error("unknown_managed_service_package_profile");
const historicalPrefix = "pirate-managed-firstsong-20261105", prefix = fresh || helperOnly ? process.env.MANAGED_WEB2_PREFIX! : historicalPrefix;
// Before state/provider initialization, bind the reviewed generated package,
// explicit plan and actual Alchemy.Stack namespace. Existing encrypted local
// state stores resources under state/<stack>/<stage>; Stack uses this same prefix.
const selectedPackage = fresh || helperOnly ? (() => {
  if (!/^pirate-[a-z0-9-]{1,48}(?![\s\S])/.test(prefix ?? "") || prefix.startsWith(historicalPrefix))
    throw new Error("fresh_managed_stack_identity_required");
  const bytes = packageBytes ?? readFileSync(new URL("./managed-web2-package.json", import.meta.url));
  if (bytes.length > 2 * 1024 * 1024 || "0x" + createHash("sha256").update(bytes).digest("hex") !== process.env.MANAGED_WEB2_PACKAGE_DIGEST)
    throw new Error("managed_package_pin_changed");
  const p = JSON.parse(bytes.toString("utf8")), i = p.identity;
  if (p.prefix !== prefix || p.packageProfile !== selectedProfile || i.prefix !== prefix || i.packageProfile !== selectedProfile ||
    i.planId !== process.env.MANAGED_WEB2_PLAN_ID || !/^0x[0-9a-f]{64}(?![\s\S])/.test(i.planId) ||
    i.state.store !== "pirate-encrypted-local" || i.state.stack !== prefix) throw new Error("managed_package_stack_changed");
  return p;
})() : undefined;
const signingAssets = selectedPackage?.operatorSigning ? {
  assets: { directory: "./operator-signing", runWorkerFirst: true, htmlHandling: "none" as const, notFoundHandling: "none" as const },
} : {};
export default Alchemy.Stack(
  prefix,
  { providers: Cloudflare.providers(), state: encryptedLocalState() },
  Effect.gen(function* () {
    if (helperOnly) {
      if (!selectedPackage?.operatorSigning) throw new Error("operator_signing_closure_unavailable");
      const helper = yield* Cloudflare.Worker("SigningHelper", {
        name: prefix, main: "./worker/worker.mjs", bundle: false, ...signingAssets,
        compatibility: { date: "2026-11-15", flags: ["nodejs_compat", "global_fetch_strictly_public"] },
        workersDev: { enabled: true, previewsEnabled: false },
        observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true, headSamplingRate: 0.1 } },
        env: { MANAGED_PUBLISHING_PROFILE: "operator-signing-only", OPERATOR_SIGNING_PROFILE_JSON: JSON.stringify(selectedPackage.operatorSigning) },
      });
      return { origin: helper.url, profile: "operator-signing-only", planId: selectedPackage.identity.planId };
    }
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
      ...(fresh ? signingAssets : {}),
      compatibility: {
        date: fresh ? "2026-11-15" : "2026-11-04",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      workersDev: { enabled: true, previewsEnabled: false },
      crons: ["* * * * *"],
      limits: { cpuMs: 30000 },
      observability: {
        enabled: true,
        redactQueryString: true,
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
        // Owner publishing binds only the reviewed owner grant; a registered
        // deployment binds only the registered grant and registration key.
        ...(fresh
          ? { MANAGED_PUBLISHING_PROFILE: "managed-web2",
              MANAGED_PUBLISHING_CONFIGURATION_JSON: JSON.stringify(selectedPackage.publishing),
              SERVICE_CONFIGURATION_TRUST_JSON: JSON.stringify(selectedPackage.trust),
              ...(selectedPackage.operatorSigning ? { OPERATOR_SIGNING_PROFILE_JSON: JSON.stringify(selectedPackage.operatorSigning) } : {}) }
          : process.env.OWNER_GRANT_JSON
          ? { OWNER_GRANT_JSON: process.env.OWNER_GRANT_JSON }
          : {
              RELEASE_GRANT_JSON: process.env.RELEASE_GRANT_JSON!,
              REGISTRATION_OPERATOR_PRIVATE_KEY: Config.Redacted(
                "REGISTRATION_OPERATOR_PRIVATE_KEY",
              ),
            }),
        FILEBASE_IPFS_TOKEN: Config.Redacted("FILEBASE_IPFS_TOKEN"),
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
    if (fresh) {
      const recognitionDB = yield* Cloudflare.D1.Database("RecognitionDatabase", {
        name: `${prefix}-recognition-db`, migrations: "./recognition-migrations",
      });
      const recognitionJOBS = yield* Cloudflare.Queues.Queue("RecognitionJobs", { name: `${prefix}-recognition-jobs` });
      const recognition = yield* Cloudflare.Worker("RecognitionApp", {
        name: `${prefix}-recognition`, main: "./worker/recognition.mjs", bundle: false,
        compatibility: { date: "2026-11-15", flags: ["nodejs_compat", "global_fetch_strictly_public"] },
        workersDev: { enabled: true, previewsEnabled: false }, crons: ["* * * * *"], limits: { cpuMs: 30000 },
        observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true },
          traces: { enabled: true, headSamplingRate: 0.1 } },
        env: { DB: recognitionDB, ADMISSION_DB: DB, JOBS: recognitionJOBS,
          MANAGED_PUBLISHING_CONFIGURATION_JSON: JSON.stringify(selectedPackage.publishing),
          RECOGNITION_CONFIGURATION_JSON: JSON.stringify(selectedPackage.recognition),
          SERVICE_CONFIGURATION_TRUST_JSON: JSON.stringify(selectedPackage.trust),
          RECOGNITION_SIGNER_PRIVATE_KEY: Config.Redacted("RECOGNITION_SIGNER_PRIVATE_KEY"),
          ACRCLOUD_HOST: process.env.ACRCLOUD_HOST!, ACRCLOUD_ACCESS_KEY: Config.Redacted("ACRCLOUD_ACCESS_KEY"),
          ACRCLOUD_ACCESS_SECRET: Config.Redacted("ACRCLOUD_ACCESS_SECRET"), ACRCLOUD_CATALOG_TOKEN: Config.Redacted("ACRCLOUD_CATALOG_TOKEN"),
        },
      });
      yield* Cloudflare.Queues.Consumer("RecognitionConsumer", { queueId: recognitionJOBS.queueId, scriptName: recognition.workerName,
        settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 3, maxWaitTimeMs: 1000, retryDelay: 60 } });
      return { origin: app.url, database: DB.databaseId, queue: JOBS.queueId, recognitionOrigin: recognition.url,
        recognitionDatabase: recognitionDB.databaseId, recognitionQueue: recognitionJOBS.queueId };
    }
    return { origin: app.url, database: DB.databaseId, queue: JOBS.queueId };
  }),
);
