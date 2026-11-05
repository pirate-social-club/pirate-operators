import { build } from "esbuild";

/** Bind operational entrypoints and all repository-owned runtime imports. */
export async function ownedModuleGraph(entryPoint: string) {
  const graph = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  return Object.keys(graph.metafile!.inputs).filter(
    (p) => !p.includes("node_modules/"),
  );
}
