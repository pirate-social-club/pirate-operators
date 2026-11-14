// Client release build. The entry is loaded by the unhashed /app/boot.js that
// scripts/build.ts writes from this build's manifest; there is no index.html.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { alias, dedupe } from "./vite.shared.ts";

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  resolve: { alias, dedupe },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    manifest: true,
    assetsDir: "app/assets",
    modulePreload: false,
    target: "es2022",
    rolldownOptions: {
      input: {
        entry: "src/client/entry.tsx",
        "document-v1": "src/styles/document-v1.css",
      },
    },
  },
});
