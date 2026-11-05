import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { insist } from "../packages/community/common.ts";

/** Derive the entire owned runtime import graph. Third-party imports stay
 * external and are bound by the root manifest/lock; no bundled code executes. */
export async function ownedSourceHashes(root: string, entry: string) {
  const absoluteRoot = resolve(root);
  const built = await build({
    absWorkingDir: absoluteRoot,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const paths = [
    ...Object.keys(built.metafile.inputs),
    "package.json",
    "package-lock.json",
  ];
  const hashes: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    const owned = relative(absoluteRoot, resolve(absoluteRoot, path));
    insist(
      owned !== ".." &&
        !owned.startsWith(".." + sep) &&
        !isAbsolute(owned) &&
        !owned.split(sep).includes("node_modules"),
      "qualification_import_outside_owned_source",
    );
    hashes[owned.split(sep).join("/")] = createHash("sha256")
      .update(await readFile(resolve(absoluteRoot, path)))
      .digest("hex");
  }
  return hashes;
}
