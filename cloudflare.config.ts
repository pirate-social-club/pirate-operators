import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Packaging template only. The harness supplies isolated local Worker configs.
export default defineConfig({
  worker: {
    name: "pirate-operators-local-skeleton",
    compatibilityDate: "2026-11-03",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      ServiceState: exports.durableObject({ storage: "sqlite" }),
      VeryAttesterState: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      LOCAL_ONLY: bindings.text("disabled"),
      STATE: bindings.durableObject({
        worker: "pirate-operators-local-skeleton",
        exportName: "ServiceState",
      }),
    },
  },
});
