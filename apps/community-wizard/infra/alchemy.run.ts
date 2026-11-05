// Stack/provider pattern follows creator-spike a9810cc; this stack owns its resources independently.
import * as Alchemy from "alchemy";
import { encryptedLocalState } from "./encrypted-state.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";

const slug = process.env.COMMUNITY_SLUG!;
if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug))
  throw new Error("Invalid community deployment ID");
const prefix = `pirate-${slug}`;
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
      compatibility: { date: "2026-11-04", flags: ["nodejs_compat"] },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: {
        enabled: true,
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      env: {
        DB,
        MEDIA,
        JOBS,
        COMMUNITY_NAME: process.env.COMMUNITY_NAME!,
        PLAN_ID: process.env.PLAN_ID!,
        ...(process.env.MODERATION_MODE === "independent"
          ? {
              OPENAI_API_KEY: Config.Redacted("OPENAI_API_KEY"),
              ...(process.env.CLOUDCONVERT_API_KEY
                ? {
                    CLOUDCONVERT_API_KEY: Config.Redacted(
                      "CLOUDCONVERT_API_KEY",
                    ),
                  }
                : {}),
            }
          : {}),
      },
    });
    return { origin: app.url, database: DB.databaseId };
  }),
);
