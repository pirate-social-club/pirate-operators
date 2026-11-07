// In-memory source binding; no key, state, provider or RPC access.
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { keccak256 } from "viem";
import { hashJson } from "../../packages/community/common.ts";
export function studyActivationSourceHash() {
  const graph = buildSync({
    entryPoints: ["harness/megaeth/study-activation.ts"],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  return hashJson(
    Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(graph.metafile!.inputs),
          "contracts/LearningResultsV3.sol",
          "package.json",
          "package-lock.json",
        ]),
      ]
        .sort()
        .map((path) => [path, keccak256(new Uint8Array(readFileSync(path)))]),
    ),
  );
}
