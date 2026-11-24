// Tier-tag conformance for app stories: the sidebar groups feature-first,
// so the tier discipline lives in story metadata, enforced here.
// - tags must be exactly one of: screen, flow, part
// - a flow-tagged story file must contain at least one play function
// - a screen-tagged meta must not disable the two page-level axe rules:
//   a route-level view owns the page structure, so disabling them marks a
//   fragment, which belongs to the flow or part tier
// Same script convention as scripts/storybook/check-production-imports.mjs.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS = ["screen", "flow", "part"];
const PAGE_RULES = ["landmark-one-main", "page-has-heading-one"];

export function parseMeta(source) {
  const title = /title: "([^"]+)"/.exec(source)?.[1] ?? null;
  const tag = /tags: \["([a-z]+)"\]/.exec(source)?.[1] ?? null;
  const hasPlay = /\bplay:/.test(source);
  const disablesPageRules = PAGE_RULES.every((rule) => source.includes(`{ id: "${rule}", enabled: false }`));
  return { title, tag, hasPlay, disablesPageRules };
}

export function scanSources(files) {
  const findings = [];
  for (const [name, source] of Object.entries(files)) {
    const meta = parseMeta(source);
    if (meta.title === null) continue;
    if (!meta.tag) {
      findings.push(`${name}: missing a tier tag (screen, flow or part)`);
      continue;
    }
    if (!TIERS.includes(meta.tag)) {
      findings.push(`${name}: unknown tier tag "${meta.tag}"`);
      continue;
    }
    if (meta.tag === "flow" && !meta.hasPlay) {
      findings.push(`${name}: a flow-tagged story file must carry at least one play function`);
    }
    if (meta.tag === "screen" && meta.disablesPageRules) {
      findings.push(
        `${name}: a screen owns the page structure; disabling page-level axe rules marks a fragment, which belongs to flow or part`,
      );
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
    else if (/\.stories\.tsx$/.test(name.name) && !rel.includes("reference/")) {
      entries.push(rel);
    }
  }
  return entries;
}

export function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = argv[0] === "--root" && argv[1] ? path.resolve(argv[1]) : path.resolve(here, "../../src");
  const files = Object.fromEntries(walk(root).map((rel) => [rel, readFileSync(path.join(root, rel), "utf8")]));
  const findings = scanSources(files);
  if (findings.length) {
    console.error(`story-conformance: ${findings.length} tier violation(s):`);
    for (const finding of findings) console.error(`  ${finding}`);
    return 1;
  }
  console.log(`story-conformance: ${Object.keys(files).length} story file(s) tiered correctly`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
