// Qualify the actual pinned Prebuilt reader; no stack, provider or credential executes.
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { canonical, insist } from "../packages/community/common.ts";
import { digest } from "./private-json.ts";
import { communityDependencyModules } from "./community-dependencies.ts";
import type { OperatorProfile } from "./study-operator-profile.ts";
import type { prepareOperatorPackage } from "./study-operator-package.ts";
export const operatorPackageFiles = [
  "encrypted-state.ts",
  "learning-bindings.ts",
  "learning-testnet.alchemy.ts",
  "operator.mjs",
  "protected-data.ts",
] as const;
export const prebuiltReaderSha256 =
  "0xef714ea3462f9d9253445da9042647c2108b6339e18b9848aa183dc1931baa95";
export interface OperatorModuleClosure {
  modules: 1;
  module: "operator.mjs";
  bytes: number;
  sha256: string;
  providerVersion: "2.0.0-beta.85";
  readerSha256: string;
}
export async function readPinnedOperatorBundle(
  main: string,
  modules = communityDependencyModules,
) {
  const provider = join(modules, "@alchemy.run/cloudflare");
  const metadata = JSON.parse(
    await readFile(join(provider, "package.json"), "utf8"),
  );
  const reader = join(provider, "lib/Workers/Sources/Prebuilt.js");
  insist(
    metadata.version === "2.0.0-beta.85" &&
      digest(await readFile(reader)) === prebuiltReaderSha256,
    "study_operator_prebuilt_reader_changed",
    409,
  );
  const require = createRequire(join(provider, "package.json"));
  const [Effect, FileSystem, { readPrebuiltWorkerBundle }] = await Promise.all([
    import(pathToFileURL(require.resolve("effect/Effect")).href),
    import(pathToFileURL(require.resolve("effect/FileSystem")).href),
    import(pathToFileURL(reader).href),
  ]);
  const fs = {
    readFile: (path: string) => Effect.tryPromise(() => readFile(path)),
  };
  return Effect.runPromise(
    readPrebuiltWorkerBundle({ main }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  ) as Promise<{
    files: { path: string; content: Uint8Array; hash: string }[];
    hash: string;
  }>;
}
export async function assertOperatorModuleClosure(
  profile: OperatorProfile,
  directory: string,
  prepared: Awaited<ReturnType<typeof prepareOperatorPackage>>,
  modules = communityDependencyModules,
): Promise<OperatorModuleClosure> {
  insist(
    canonical(Object.keys(prepared.files).sort()) ===
      canonical(operatorPackageFiles),
    "study_operator_package_file_set_changed",
    409,
  );
  const names = (await readdir(directory)).sort();
  insist(
    canonical(names) ===
      canonical([...operatorPackageFiles, "package-manifest.json"].sort()),
    "study_operator_upload_directory_unclassified",
    409,
  );
  insist(
    (await realpath(directory)) === directory,
    "study_operator_upload_directory_escaped",
    409,
  );
  for (const name of names) {
    const path = join(directory, name),
      info = await lstat(path);
    insist(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid!() &&
        !(info.mode & 0o077),
      "study_operator_upload_file_not_private_regular",
      409,
    );
    if (name !== "package-manifest.json")
      insist(
        digest(await readFile(path)) === digest(prepared.files[name]!),
        "study_operator_upload_bytes_changed",
        409,
      );
  }
  const dependencies = join(dirname(directory), "node_modules"),
    link = await lstat(dependencies);
  insist(
    link.isSymbolicLink() &&
      (await realpath(dependencies)) === (await realpath(modules)),
    "study_operator_ancestor_dependencies_changed",
    409,
  );
  const require = createRequire(join(directory, "learning-testnet.alchemy.ts"));
  for (const name of ["alchemy", "@alchemy.run/cloudflare", "effect/Effect"]) {
    const expected = await realpath(
      join(modules, name === "effect/Effect" ? "effect" : name),
    );
    const actual = await realpath(require.resolve(name)),
      from = relative(expected, actual);
    insist(
      from !== ".." && !from.startsWith(".." + sep) && !from.startsWith(sep),
      "study_operator_ancestor_resolution_changed",
      409,
    );
  }
  const bundle = await readPinnedOperatorBundle(
    join(directory, "operator.mjs"),
    modules,
  );
  const file = bundle.files[0];
  insist(
    bundle.files.length === 1 &&
      file?.path === "operator.mjs" &&
      profile.execution.moduleName === "operator.mjs" &&
      file.content.length === profile.artifact.bytes &&
      digest(file.content) === profile.artifact.sha256,
    "study_operator_upload_closure_changed",
    409,
  );
  return {
    modules: 1,
    module: "operator.mjs",
    bytes: file.content.length,
    sha256: digest(file.content),
    providerVersion: "2.0.0-beta.85",
    readerSha256: prebuiltReaderSha256,
  };
}
