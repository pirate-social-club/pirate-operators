import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("dist/worker", { recursive: true });
await copyFile(
  "node_modules/@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm",
  "dist/worker/ika.wasm",
);
await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  conditions: ["workerd", "browser"],
  external: ["node:*"],
  plugins: [
    {
      name: "worker-ika",
      setup(b) {
        b.onResolve({ filter: /^@ika\.xyz\/ika-wasm$/ }, () => ({
          path: resolve("src/server/worker-wasm.ts"),
        }));
        b.onResolve({ filter: /\.wasm$/ }, () => ({
          path: "./ika.wasm",
          external: true,
        }));
      },
    },
  ],
});
