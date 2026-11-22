// Token-conformance audit for apps/web product source: raw hex color literals
// outside the token sheet are findings. Each exempt path is named below with
// its reason; there are no broad exclusions. Same script convention as
// scripts/storybook/check-production-imports.mjs.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Named exemptions, never patterns. A path entry covers only that exact file;
// a directory entry (ending in "/") covers only files under it.
export const ALLOWED = [
  {
    path: "src/styles/document-v1.css",
    reason:
      "frozen published document contract, digest-sealed in document-versions.json; restyling needs a new document version",
  },
  {
    path: "src/media/reference/",
    reason:
      "pinned reference provenance tree copied as evidence, not product styling authority",
  },
  {
    path: "src/media/reference-capture.tsx",
    reason: "reference capture provenance surface for the same pinned tree",
  },
  {
    path: "src/dance/source/dance-song-page.tsx",
    reason:
      "dance fork dark media backdrop; removed by task-record item 7 (fork-drift reconciliation) of pirate-ui-design-lock-20261121, not a permanent exemption",
  },
  {
    path: "src/dance/source/dance-review-page.tsx",
    reason:
      "dance fork dark media backdrop; removed by task-record item 7 (fork-drift reconciliation) of pirate-ui-design-lock-20261121, not a permanent exemption",
  },
  {
    path: "src/dance/source/video-original-audio-surface.tsx",
    reason:
      "dance fork gradient and backdrop; removed by task-record item 7 (fork-drift reconciliation) of pirate-ui-design-lock-20261121, not a permanent exemption",
  },
];

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const SCANNED = new Set([".ts", ".tsx", ".css"]);

/** Hex color literals in one source text: 3, 4, 6 or 8 hex digits. */
export function findHexLiterals(text) {
  const found = [];
  for (const match of text.matchAll(HEX)) {
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(match[0]) ||
        /^#(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/.test(match[0])) {
      found.push({ index: match.index, literal: match[0] });
    }
  }
  return found;
}

/** True when a repo-relative path is covered by a named exemption. */
export function isAllowed(relativePath, allowed = ALLOWED) {
  return allowed.some((entry) =>
    entry.path.endsWith("/") ? relativePath.startsWith(entry.path) : relativePath === entry.path,
  );
}

/** Findings for a virtual file map { relativePath: text }, for tests. */
export function scanFiles(files, allowed = ALLOWED) {
  const findings = [];
  for (const [name, text] of Object.entries(files)) {
    if (isAllowed(name, allowed)) continue;
    const lines = text.split("\n");
    for (const literal of findHexLiterals(text)) {
      const before = text.slice(0, literal.index);
      const line = before.split("\n").length;
      findings.push({
        file: name,
        line,
        literal: literal.literal,
        context: lines[line - 1]?.trim().slice(0, 90) ?? "",
      });
    }
  }
  return findings;
}

function walk(root, relative = "") {
  const entries = [];
  for (const name of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name.startsWith(".")) continue;
    const rel = relative ? `${relative}/${name.name}` : name.name;
    if (name.isDirectory()) entries.push(...walk(root, rel));
    else if (SCANNED.has(path.extname(name.name))) entries.push(`src/${rel}`);
  }
  return entries;
}

export function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = argv[0] === "--root" && argv[1] ? path.resolve(argv[1]) : path.resolve(here, "../../src");
  const files = walk(root);
  const scanned = new Map();
  for (const rel of files) scanned.set(rel, readFileSync(path.join(root, rel.slice("src/".length)), "utf8"));
  const findings = scanFiles(Object.fromEntries(scanned));
  if (findings.length) {
    console.error(`token-conformance: ${findings.length} raw hex literal(s) outside the token sheet:`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} ${finding.literal}  ${finding.context}`);
    }
    console.error("Map them onto tokens.css, or add the exact path to ALLOWED with a reason.");
    return 1;
  }
  console.log(
    `token-conformance: ${files.length} scanned file(s) clean; ${ALLOWED.length} named exemption(s) untouched`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
