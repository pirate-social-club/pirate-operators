// Tier-tag conformance for app stories: the sidebar groups feature-first,
// so the tier discipline lives in story metadata, enforced here.
// - tags must be exactly one of: screen, flow, part
// - a flow-tagged story file must contain at least one play function
// - a screen-tagged meta must not disable the three page-level axe rules:
//   a route-level view owns the page structure, so disabling them marks a
//   fragment, which belongs to the flow or part tier
// Same script convention as scripts/storybook/check-production-imports.mjs.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const TIERS = ["screen", "flow", "part"];
const PAGE_RULES = ["landmark-one-main", "page-has-heading-one", "region"];

function propertyKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function functionValue(node, callableNames) {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  return ts.isIdentifier(node) && callableNames.has(node.text);
}

function exportedStoryPlay(node, callableNames) {
  if (!ts.isVariableStatement(node)) return false;
  const exported = ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (!exported) return false;
  return node.declarationList.declarations.some((declaration) => {
    if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) return false;
    return declaration.initializer.properties.some((property) => {
      if (ts.isMethodDeclaration(property) && propertyKey(property.name) === "play") return true;
      return ts.isPropertyAssignment(property) &&
        propertyKey(property.name) === "play" &&
        functionValue(property.initializer, callableNames);
    });
  });
}

function parseEvidence(source) {
  const ast = ts.createSourceFile("story.stories.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callableNames = new Set();
  const disabledPageRules = new Set();
  const collectCallables = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) callableNames.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && functionValue(node.initializer, callableNames)) {
      callableNames.add(node.name.text);
    }
    ts.forEachChild(node, collectCallables);
  };
  collectCallables(ast);
  let hasPlay = false;
  const visit = (node) => {
    if (exportedStoryPlay(node, callableNames)) hasPlay = true;
    if (ts.isObjectLiteralExpression(node)) {
      let id = null;
      let enabled = true;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyKey(property.name);
        if (key === "id" && ts.isStringLiteral(property.initializer)) id = property.initializer.text;
        if (key === "enabled") enabled = property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
      }
      if (id && !enabled && PAGE_RULES.includes(id)) disabledPageRules.add(id);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { hasPlay, disabledPageRules };
}

export function parseMeta(source) {
  const title = /title: "([^"]+)"/.exec(source)?.[1] ?? null;
  const tag = /tags: \["([a-z]+)"\]/.exec(source)?.[1] ?? null;
  const evidence = parseEvidence(source);
  return {
    title,
    tag,
    hasPlay: evidence.hasPlay,
    disablesPageRules: evidence.disabledPageRules.size > 0,
    disabledPageRules: [...evidence.disabledPageRules],
  };
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
