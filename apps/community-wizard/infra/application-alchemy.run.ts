// In-place application successor. Logical IDs and setup stage retain wizard ownership.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { encryptedLocalState } from "./encrypted-state.ts";

export default Alchemy.Stack(
  "pirate-first-song-20261105",
  { providers: Cloudflare.providers(), state: encryptedLocalState() },
  Effect.gen(function* () {
    const DB = yield* Cloudflare.D1.Database("Database", {
      name: "pirate-first-song-20261105-db",
      migrations: "./migrations",
    });
    const MEDIA = yield* Cloudflare.R2.Bucket("Media", {
      name: "pirate-first-song-20261105-media",
      publicAccess: false,
    });
    const JOBS = yield* Cloudflare.Queues.Queue("Jobs", {
      name: "pirate-first-song-20261105-jobs",
    });
    const app = yield* Cloudflare.Worker("App", {
      name: "pirate-first-song-20261105",
      main: "./worker/worker.mjs",
      bundle: false,
      assets: {
        directory: "./assets",
        runWorkerFirst: true,
        notFoundHandling: "single-page-application",
      },
      compatibility: {
        date: "2026-11-04",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: { enabled: false },
      env: {
        DB,
        MEDIA,
        JOBS,
        COMMUNITY_NAME: "First Song Managed Test",
        PLAN_ID:
          "9643bdc3b56af2064f61e19d2031a544d99e6bd2aa3994f1714be61ee5c7c721",
        APPLICATION_PROFILE_HASH: process.env.APPLICATION_PROFILE_HASH!,
        CREATOR_PROFILE_HASH: process.env.CREATOR_PROFILE_HASH!,
        COMMUNITY_PUBLISHER_PRIVATE_KEY: Config.Redacted(
          "COMMUNITY_PUBLISHER_PRIVATE_KEY",
        ),
      },
    });
    return { origin: app.url, database: DB.databaseId };
  }),
);
