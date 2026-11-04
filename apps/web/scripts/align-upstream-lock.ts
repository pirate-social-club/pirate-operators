// Report installed packages whose version differs from pirate-web-solid's
// lockfile, and the npm overrides that would align them.
//
// Usage: node scripts/align-upstream-lock.ts <bun.lock> [--write]
//
// The client starts on the dependency set the centralized client already runs
// and tests (contract section 7). npm resolves the design system's caret
// ranges independently of that lockfile, so this script pins the Solid
// runtime, compiler, design-system and Vite/Tailwind closure to the upstream
// resolution. Other overlapping packages (Babel internals, browser data) are
// only reported: upstream nests older majors of some of them, and a global
// npm override would replace those nested copies too. Only top-level lockfile
// entries are used.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [lockPath, flag] = process.argv.slice(2);
if (lockPath === undefined) throw new Error("usage: align-upstream-lock.ts <bun.lock> [--write]");

const upstream = new Map<string, string>();
const entry = /^ {4}"([^"]+)": \["((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm;
for (const match of readFileSync(lockPath, "utf8").matchAll(entry)) {
  const [, key, name, version] = match;
  if (key !== name || version.includes("/")) continue; // nested or file: entry
  upstream.set(name, version);
}

type Tree = { version?: string; dependencies?: Record<string, Tree> };
const tree = JSON.parse(
  execFileSync("npm", ["ls", "--all", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }),
) as Tree;

const installed = new Map<string, Set<string>>();
const visit = (node: Tree) => {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (child.version !== undefined) {
      const versions = installed.get(name) ?? new Set<string>();
      versions.add(child.version);
      installed.set(name, versions);
    }
    visit(child);
  }
};
visit(tree);

const aligned = /^(solid-js|@solidjs\/|@solid-primitives\/|@kobalte\/|seroval|babel-preset-solid|@dom-expressions\/|babel-plugin-jsx-dom-expressions|@floating-ui\/|@internationalized\/|class-variance-authority|tailwind-merge|tailwindcss|@tailwindcss\/|lightningcss|vite$|rolldown|@rolldown\/|@oxc-project\/|@swc\/helpers|tslib)/;
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const overrides: Record<string, string> = { ...manifest.overrides };
const changes: string[] = [];
for (const [name, versions] of [...installed].sort(([a], [b]) => a.localeCompare(b))) {
  const want = upstream.get(name);
  if (want === undefined) continue;
  const direct = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  if (direct !== undefined) {
    if (direct !== want && !direct.startsWith("file:")) changes.push(`direct ${name} ${direct} upstream ${want}`);
    continue; // direct pins are reviewed by hand, not overridden
  }
  if (versions.size === 1 && versions.has(want) && overrides[name] === undefined) continue;
  if (overrides[name] !== undefined && overrides[name] === want) continue;
  if (overrides[name]?.startsWith("file:")) continue;
  if (!aligned.test(name)) {
    changes.push(`report-only ${name} ${[...versions].join(",")} upstream ${want}`);
    continue;
  }
  changes.push(`${name} ${[...versions].join(",")} -> ${want}`);
  overrides[name] = want;
}

for (const line of changes) console.log(line);
if (flag === "--write" && changes.some(line => !line.startsWith("report-only") && !line.startsWith("direct"))) {
  manifest.overrides = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n");
}
