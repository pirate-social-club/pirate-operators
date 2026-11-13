import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const storyPattern = /\.stories\.[cm]?[jt]sx?$/u;
const testPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const codePattern = /\.[cm]?[jt]sx?$/u;

// Adapted from c7cb8783's production-reachability audit. Fixture support
// is explicit and traversed, rather than exempted by its filename.
const supportPaths = [
  "src/study/studying-story-fixtures.ts",
  "src/karaoke/story-fixtures.ts",
  "test/dance-story-fixtures.tsx",
  "test/dance-repair-story-fixtures.tsx",
  "test/dance-source-fixtures.ts",
  "test/dance-command-storage.ts",
];

export function runtimeSpecifiers(text, fileName = "input.tsx") {
  // Infer TS/TSX/JS/JSX from the actual module path. Valid .ts generic
  // arrows must not be interpreted as JSX while traversing production.
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0];
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new Error(
      `Cannot audit syntactically invalid source ${fileName}:${position.line + 1}:${position.character + 1}: ${detail}`,
    );
  }

  const found = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const hasValue =
        !clause ||
        (!clause.isTypeOnly &&
          (clause.name ||
            (bindings && ts.isNamespaceImport(bindings)) ||
            (bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.some((item) => !item.isTypeOnly))));
      if (hasValue) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (
        !clause ||
        !ts.isNamedExports(clause) ||
        clause.elements.some((item) => !item.isTypeOnly)
      ) {
        add(node.moduleSpecifier);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // Computed imports are outside this static audit's proof boundary.
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...new Set(found)];
}

export function auditGraph({ entries, stories, importsOf, support }) {
  if (entries.length === 0) throw new Error("No production entries selected");
  if (stories.length === 0) throw new Error("No app stories selected");

  const closure = (roots) => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...importsOf(file));
    }
    return seen;
  };

  const production = closure(entries);
  const violations = [];
  for (const file of production) {
    if (storyPattern.test(file) || testPattern.test(file) || support.has(file)) {
      violations.push(`Production imports story/test support: ${file}`);
    }
  }

  for (const story of stories) {
    const reached = closure([story]);
    let componentModuleReached = false;
    for (const file of reached) {
      if (file === story) continue;
      if (production.has(file)) {
        if (/\.[jt]sx$/u.test(file)) componentModuleReached = true;
      } else if (!support.has(file)) {
        violations.push(`${story} imports unreachable module: ${file}`);
      }
    }
    if (!componentModuleReached) {
      violations.push(`${story} reaches no production JSX component module`);
    }
  }
  return violations;
}

function listStories(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listStories(file);
    return storyPattern.test(file) ? [file] : [];
  });
}

export function checkApp(root) {
  const configPath = path.join(root, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error("Cannot read app tsconfig");
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    root,
  );
  if (config.errors.length) throw new Error("Cannot parse app tsconfig");

  const cache = new Map();
  const importsOf = (file) => {
    if (cache.has(file)) return cache.get(file);
    const resolved = runtimeSpecifiers(readFileSync(file, "utf8"), file).flatMap(
      (specifier) => {
        const owned =
          specifier.startsWith(".") ||
          specifier.startsWith("@/") ||
          specifier === "@pirate/web-solid-ui";
        if (!owned) return [];
        if (
          specifier.startsWith(".") &&
          path.extname(specifier) &&
          !codePattern.test(specifier)
        ) {
          return [];
        }
        const result = ts.resolveModuleName(
          specifier,
          file,
          config.options,
          ts.sys,
        ).resolvedModule;
        if (!result || result.resolvedFileName.endsWith(".d.ts")) {
          throw new Error(`Unresolved runtime import ${specifier} in ${file}`);
        }
        return [path.resolve(result.resolvedFileName)];
      },
    );
    cache.set(file, resolved);
    return resolved;
  };

  const stories = listStories(path.join(root, "src")).sort();
  const violations = auditGraph({
    entries: [
      path.join(root, "src/client/entry.tsx"),
      path.join(root, "src/live/entry.tsx"),
    ],
    stories,
    importsOf,
    support: new Set(supportPaths.map((file) => path.join(root, file))),
  });
  return {
    proof: "static-runtime-module-reachability",
    limitations: [
      "Computed imports and external package internals are not traversed",
      "Module reachability does not prove mounted exports or rendered parity",
      "No interaction, accessibility, service or native acceptance",
    ],
    stories: stories.map((file) => path.relative(root, file)),
    violations,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = checkApp(root);
    console.log(JSON.stringify(result, null, 2));
    if (result.violations.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
