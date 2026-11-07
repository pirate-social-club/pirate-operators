// Public source/artifact preparation only. Building does not execute the bundle.
import { build } from "esbuild";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { canonical, insist } from "../packages/community/common.ts";
import type { OperatorProfile } from "./study-operator-profile.ts";
const digest = (v: Uint8Array | string) =>
  "0x" + createHash("sha256").update(v).digest("hex");
const support = [
  "learning-testnet.alchemy.ts",
  "learning-bindings.ts",
  "encrypted-state.ts",
  "protected-data.ts",
];
export async function prepareOperatorPackage(sourceRoot: string) {
  const root = await realpath(sourceRoot);
  const runtime = await build({
    absWorkingDir: root,
    entryPoints: ["services/karaoke-audio-runtime.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    metafile: true,
    logLevel: "silent",
  });
  const control = await build({
    absWorkingDir: root,
    entryPoints: ["harness/study-operator-release.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const owned = (path: string) => !path.split(/[\\/]/).includes("node_modules");
  const paths = [
    ...new Set([
      ...Object.keys(runtime.metafile!.inputs),
      ...Object.keys(control.metafile!.inputs),
      ...support.map((x) => "apps/community-wizard/infra/" + x),
      "package.json",
      "package-lock.json",
      "apps/community-wizard/package-lock.json",
    ]),
  ]
    .filter(owned)
    .sort();
  const sourceHashes: Record<string, string> = {};
  for (const path of paths) {
    const actual = await realpath(resolve(root, path));
    insist(
      !relative(root, actual).startsWith(".." + sep) &&
        !relative(root, actual).startsWith(sep),
      "study_operator_source_escape",
      409,
    );
    sourceHashes[path] = digest(await readFile(actual));
  }
  const original = await readFile(
    resolve(root, "apps/community-wizard/infra/learning-testnet.alchemy.ts"),
    "utf8",
  );
  const pattern =
    /main:\s*resolve\(\s*import\.meta\.dirname,\s*["']\.\.\/\.\.\/\.\.\/\.local\/learning-testnet\/operator\.mjs["'],?\s*\)/g;
  insist(
    [...original.matchAll(pattern)].length === 1,
    "study_operator_stack_entry_shape_changed",
    409,
  );
  const files: Record<string, Uint8Array> = {
    "operator.mjs": runtime.outputFiles[0]!.contents,
  };
  files["learning-testnet.alchemy.ts"] = new TextEncoder().encode(
    original.replace(
      pattern,
      'main: resolve(import.meta.dirname, "./operator.mjs")',
    ),
  );
  for (const name of support.filter((x) => x !== "learning-testnet.alchemy.ts"))
    files[name] = await readFile(
      resolve(root, "apps/community-wizard/infra", name),
    );
  return {
    root,
    sourceHashes,
    artifactSha256: digest(files["operator.mjs"]!),
    artifactBytes: files["operator.mjs"]!.length,
    files,
  };
}
export function assertOperatorPackage(
  profile: OperatorProfile,
  prepared: Awaited<ReturnType<typeof prepareOperatorPackage>>,
) {
  insist(
    prepared.artifactSha256 === profile.artifact.sha256 &&
      prepared.artifactBytes === profile.artifact.bytes &&
      canonical(prepared.sourceHashes) ===
        canonical(profile.artifact.sourceHashes),
    "study_operator_source_or_artifact_changed",
    409,
  );
}
