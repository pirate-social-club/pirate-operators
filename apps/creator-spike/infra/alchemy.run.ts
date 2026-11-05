import * as Alchemy from "alchemy";
import { encryptedLocalState } from "./encrypted-state.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";

export default Alchemy.Stack(
  "pirate-creator-wallet-testnet",
  {
    providers: Cloudflare.providers(),
    state: encryptedLocalState(),
  },
  Effect.gen(function* () {
    const DB = yield* Cloudflare.D1.Database("CreatorTestDatabase", {
      name: "pirate-creator-wallet-testnet",
      migrations: "./migrations",
    });
    const common = {
      main: "../dist/worker/index.js",
      bundle: false,
      assets: {
        directory: "../dist/client",
        runWorkerFirst: true,
        notFoundHandling: "single-page-application" as const,
      },
      compatibility: { date: "2026-11-04", flags: ["nodejs_compat"] },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: { enabled: false },
      env: {
        DB,
        NATIVE_PROFILE_HASH: process.env.NATIVE_PROFILE_HASH!,
        SUI_OPERATOR_SECRET_KEY: Config.Redacted("SUI_OPERATOR_SECRET_KEY"),
      },
    };
    const community = yield* Cloudflare.Worker("CommunityTest", {
      ...common,
      name: "pirate-creator-spike",
    });
    const wallet = yield* Cloudflare.Worker("WalletTest", {
      ...common,
      name: "pirate-wallet-test",
    });
    return {
      community: community.url,
      wallet: wallet.url,
      database: DB.databaseId,
    };
  }),
);
