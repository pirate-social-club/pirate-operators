import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { alias, dedupe } from "./vite.shared.ts";

export default defineConfig({
  root: "src/live",
  base: "/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias, dedupe },
  build: {
    outDir: "../../dist/live",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "app/assets",
    manifest: true,
    modulePreload: false,
  },
});
