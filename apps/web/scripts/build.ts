// Build one release plus its public snapshot, then pack them into a CAR.
//
// Outputs, all under dist/:
//   site/        the static site: release (/app), snapshot (/public, pages)
//   car/         site.car and car.json (root CID, digest, packing settings)
//   host/        _headers for a primary host; not part of the CAR
//   budget.json  the initial JavaScript measurement
// The build fails when the initial JavaScript exceeds the budget or when the
// frozen document-version stylesheet changes.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { FIXTURE_GENERATED_AT, fixtureCommunity, fixtureConfig, fixturePosts } from "../src/fixture/site.ts";
import { localeBootScript } from "../src/locale.ts";
import { clientRoutes, DOCUMENT_VERSION, paths, PROTOCOL_VERSION } from "../src/model.ts";
import { listFiles, packDirectory, PACKING } from "./lib/car.ts";
import {
  bootLoader,
  gzipBytes,
  headersFile,
  initialBudget,
  redirectsFile,
  sha256Hex,
  staticGraph,
  type FileDigest,
  type ViteManifest,
} from "./lib/release.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(appRoot);
const dist = join(appRoot, "dist");
const site = join(dist, "site");
const fail = (reason: string): never => {
  console.error(`build_refused:${reason}`);
  process.exit(1);
};

const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, { cwd: appRoot, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
const sourceCommit = process.env.SOURCE_COMMIT ?? git("rev-parse", "HEAD") ?? fail("source_commit_unknown");
const sourceTreeDirty = process.env.SOURCE_COMMIT === undefined && (git("status", "--porcelain", "--", ".") ?? "") !== "";
const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const version = `${pkg.version}+${sourceCommit.slice(0, 8)}`;

await rm(dist, { recursive: true, force: true });
await build({ configFile: "vite.config.ts", logLevel: "warn" });
await build({ configFile: "vite.publish.config.ts", logLevel: "warn" });

const manifest = JSON.parse(await readFile("dist/client/.vite/manifest.json", "utf8")) as ViteManifest;
const entryKey = "src/client/entry.tsx";
const documentKey = "src/styles/document-v1.css";
const documentAsset = manifest[documentKey]?.file ?? fail("document_stylesheet_missing");

const write = async (path: string, body: string | Uint8Array) => {
  const target = join(site, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
};

// Release assets. The document stylesheet leaves the hashed release tree.
await cp("dist/client/app", join(site, "app"), { recursive: true });
await rm(join(site, documentAsset));
const documentCss = await readFile(join("dist/client", documentAsset));
const documentPath = paths.documentStylesheet(DOCUMENT_VERSION);
await write(documentPath, documentCss);

const versionsFile = "document-versions.json";
const versions = JSON.parse(await readFile(versionsFile, "utf8").catch(() => "{}")) as Record<string, { stylesheet: string; sha256: string }>;
const documentSha = sha256Hex(documentCss);
const frozen = versions[String(DOCUMENT_VERSION)];
if (frozen === undefined) {
  if (process.env.ACCEPT_DOCUMENT_VERSION !== String(DOCUMENT_VERSION)) fail(`document_version_${DOCUMENT_VERSION}_not_recorded`);
  versions[String(DOCUMENT_VERSION)] = { stylesheet: documentPath, sha256: documentSha };
  await writeFile(versionsFile, JSON.stringify(versions, null, 2) + "\n");
} else if (frozen.sha256 !== documentSha) {
  fail(`document_version_${DOCUMENT_VERSION}_stylesheet_changed:${frozen.sha256}->${documentSha}`);
}

// Publication-time pages and snapshot data.
const { publish } = await import(pathToFileURL(join(dist, "publish/render.js")).href) as typeof import("../src/publish/render.tsx");
const published = publish({ config: fixtureConfig, community: fixtureCommunity, posts: fixturePosts, generatedAt: FIXTURE_GENERATED_AT });
for (const file of published.files) await write(file.path, file.body);
await write("/_redirects", redirectsFile({
  removedPostSlugs: published.removedPostSlugs,
  clientRoutes,
  shell: paths.shell,
  gone: paths.gone,
  notFound: paths.notFound,
}));

// Boot loader from the manifest's static graph.
const graph = staticGraph(manifest, entryKey);
const entry = `/${graph[0].file}`;
const preloads = graph.slice(1).map(chunk => `/${chunk.file}`);
const styles = [...new Set(graph.flatMap(chunk => chunk.css ?? []))].map(file => `/${file}`);
const boot = bootLoader({ version, entry, preloads, styles });
await write(paths.boot, boot);

const digest = async (relativePaths: readonly string[]): Promise<FileDigest[]> =>
  Promise.all(relativePaths.map(async path => {
    const bytes = await readFile(join(site, path));
    return { path: `/${path}`, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
  }));

const allFiles = await listFiles(site);
const releaseFiles = allFiles.filter(path => path.startsWith("app/"));
const release = {
  schema: "pirate.web-release/1",
  version,
  sourceCommit,
  sourceTreeDirty,
  protocolVersions: [PROTOCOL_VERSION],
  documentVersions: [DOCUMENT_VERSION],
  entry,
  boot: paths.boot,
  // The manifest cannot contain its own digest or the CID of a CAR that
  // contains it; car.json records both outside the release.
  assets: await digest(releaseFiles),
};
await write("/app/release.json", JSON.stringify(release, null, 2) + "\n");

const contentFiles = allFiles.filter(path => !path.startsWith("app/"));
const snapshot = {
  schema: "pirate.web-snapshot/1",
  fixture: fixtureConfig.fixture === true,
  communityId: fixtureConfig.communityId,
  documentVersion: DOCUMENT_VERSION,
  generatedAt: FIXTURE_GENERATED_AT,
  release: version,
  files: await digest(contentFiles),
};
await write("/public/snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");

// Initial JavaScript: boot loader, entry, static imports and inline scripts.
const inline = localeBootScript(fixtureConfig.defaultLanguage, fixtureConfig.supportedLanguages);
const budgetLines = [
  { path: paths.boot, bytes: Buffer.byteLength(boot), gzipBytes: gzipBytes(boot) },
  ...await Promise.all(graph.map(async chunk => {
    const bytes = await readFile(join(site, chunk.file));
    return { path: `/${chunk.file}`, bytes: bytes.byteLength, gzipBytes: gzipBytes(bytes) };
  })),
  { path: "inline:locale-boot", bytes: Buffer.byteLength(inline), gzipBytes: gzipBytes(inline) },
];
const budget = initialBudget(budgetLines);
await writeFile(join(dist, "budget.json"), JSON.stringify(budget, null, 2) + "\n");

// Host configuration for a primary deployment, outside the CAR.
await mkdir(join(dist, "host"), { recursive: true });
await writeFile(join(dist, "host/_headers"), headersFile(published.bootScriptSha256));

const packed = await packDirectory(site);
await mkdir(join(dist, "car"), { recursive: true });
await writeFile(join(dist, "car/site.car"), packed.car);
const carRecord = {
  schema: "pirate.web-car/1",
  rootCid: packed.rootCid,
  carSha256: packed.carSha256,
  carBytes: packed.car.byteLength,
  blockCount: packed.blockCount,
  fileCount: packed.fileCount,
  packing: PACKING,
  release: version,
  sourceCommit,
  releaseManifestSha256: sha256Hex(await readFile(join(site, "app/release.json"))),
};
await writeFile(join(dist, "car/car.json"), JSON.stringify(carRecord, null, 2) + "\n");

console.log(JSON.stringify({
  version,
  sourceTreeDirty,
  rootCid: packed.rootCid,
  carSha256: packed.carSha256,
  initialJsGzipBytes: budget.totalGzipBytes,
  budgetGzipBytes: budget.limitGzipBytes,
  files: allFiles.length + 2,
}, null, 2));
if (!budget.withinBudget) fail(`initial_js_budget_exceeded:${budget.totalGzipBytes}>${budget.limitGzipBytes}`);
