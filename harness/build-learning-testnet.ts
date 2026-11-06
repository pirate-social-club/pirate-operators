// Package source for Alchemy. No credentials or deployment side effects.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
mkdirSync(".local/learning-testnet", { recursive: true });
const result = await build({
  entryPoints: ["services/karaoke-audio-runtime.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
});
const bytes = result.outputFiles[0].contents;
writeFileSync(".local/learning-testnet/operator.mjs", bytes);
console.log(
  JSON.stringify({
    artifact: ".local/learning-testnet/operator.mjs",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);
