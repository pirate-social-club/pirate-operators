/** Explicit CI fixture input. This is not the historical preservation record.
 * Source lock + installed npm metadata + real selected package bytes are pinned;
 * actual SDK/config/migrator tests still qualify their behavior separately. */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { insist, object } from "../../packages/community/common.ts";
import type { ManagedPackageDependencyInput } from "../../harness/managed-package.ts";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function ownedManagedPackageDependencies(directory = resolve("apps/community-wizard")): Promise<ManagedPackageDependencyInput> {
  insist(directory === resolve("apps/community-wizard"), "owned_dependency_directory_required");
  return lockedPackageDependencyInput(directory, ["alchemy", "@alchemy.run/cloudflare", "@effect/platform-node", "effect"]);
}
/** Also used for small real-package filesystem fixtures; no source install or
 * protected tree is modified to exercise a resolution change. */
export async function lockedPackageDependencyInput(directory: string, roots: readonly string[]): Promise<ManagedPackageDependencyInput> {
  const modules = await realpath(join(directory, "node_modules"));
  async function capture() {
  const manifest = join(directory, "package.json"), lock = join(directory, "package-lock.json"), installed = join(modules, ".package-lock.json");
  const manifestBytes = await readFile(manifest), lockBytes = await readFile(lock), installedBytes = await readFile(installed),
    declared = object(JSON.parse(manifestBytes.toString())), records = object(object(JSON.parse(lockBytes.toString())).packages),
    npmRecords = object(object(JSON.parse(installedBytes.toString())).packages);
  const paths = new Set<string>(), edges: Array<{ from: string; name: string; resolved: string }> = [];
  async function visit(name: string, from: string, optional = false): Promise<void> {
    insist(/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name), "owned_dependency_name_invalid");
    let folder: string | undefined;
    for (let base = from; ; base = dirname(base)) {
      const candidate = join(base, "node_modules", name);
      try {
        for (const extension of [".js", ".json", ".node"]) {
          try { await lstat(candidate + extension); insist(false, "owned_dependency_unregistered_shadow"); }
          catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        }
        const info = await lstat(candidate); insist(info.isDirectory() || info.isSymbolicLink(), "owned_dependency_unregistered_shadow");
        try { insist((await lstat(join(candidate, "package.json"))).isFile(), "owned_dependency_unregistered_shadow"); }
        catch { insist(false, "owned_dependency_unregistered_shadow"); }
        folder = await realpath(candidate); break;
      }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (base === directory || dirname(base) === base) break;
    }
    if (!folder && optional) return;
    insist(folder && folder.startsWith(modules + sep), "owned_dependency_missing");
    edges.push({ from: relative(directory, from), name, resolved: relative(directory, folder) });
    if (paths.has(folder)) return;
    paths.add(folder);
    const key = relative(directory, folder).split(sep).join("/"), expected = object(records[key]), current = object(npmRecords[key]),
      info = object(JSON.parse(await readFile(join(folder, "package.json"), "utf8")));
    insist(info.name === name && info.version === expected.version && current.version === expected.version &&
      current.integrity === expected.integrity && current.resolved === expected.resolved && typeof expected.integrity === "string",
      "owned_dependency_lock_mismatch");
    const deps = object(info.dependencies ?? {}), optionalDeps = object(info.optionalDependencies ?? {});
    for (const dep of Object.keys(deps)) await visit(dep, folder, Object.hasOwn(optionalDeps, dep));
    for (const dep of Object.keys(optionalDeps)) if (!Object.hasOwn(deps, dep)) await visit(dep, folder, true);
    const peers = object(info.peerDependencies ?? {}), meta = object(info.peerDependenciesMeta ?? {});
    for (const dep of Object.keys(peers)) await visit(dep, folder, object(meta[dep] ?? {}).optional === true);
  }
  const declaredDeps = object(declared.dependencies);
  for (const name of roots) { insist(typeof declaredDeps[name] === "string", "owned_dependency_root_missing"); await visit(name, directory); }
  const files: string[] = [manifest, lock, installed];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".bin", ".cache"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { insist(entry.isFile() && !entry.isSymbolicLink(), "owned_dependency_nonregular"); files.push(path); }
    }
  }
  for (const path of paths) await walk(path);
  const pinned = await Promise.all([...new Set(files)].sort().map(async path => ({ path, sha256: digest(await readFile(path)) })));
  const treeSha256 = digest(Buffer.from(JSON.stringify({ edges: edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), files: pinned.map(row => ({ path: relative(directory, row.path), sha256: row.sha256 })) })));
  const provenance = Object.freeze({ kind: "owned-committed-lock", modules, manifestSha256: digest(manifestBytes), lockSha256: digest(lockBytes), installedLockSha256: digest(installedBytes), treeSha256 });
  return provenance;
  }
  const provenance = await capture();
  return Object.freeze({ modules, provenance, async verify() {
    try {
      insist(await realpath(join(directory, "node_modules")) === modules, "owned_dependency_input_changed");
      const current = await capture();
      insist(JSON.stringify(current) === JSON.stringify(provenance), "owned_dependency_input_changed");
    } catch { insist(false, "owned_dependency_input_changed"); }
  } });
}
