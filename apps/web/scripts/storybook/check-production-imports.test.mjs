import assert from "node:assert/strict";
import test from "node:test";
import {
  auditGraph,
  runtimeSpecifiers,
} from "./check-production-imports.mjs";

function inspect({
  fixtureImports = ["component.tsx"],
  productionImports = ["component.tsx"],
  stories = ["screen.stories.tsx"],
} = {}) {
  const graph = new Map([
    ["entry.tsx", productionImports],
    ["screen.stories.tsx", ["fixture.tsx"]],
    ["fixture.tsx", fixtureImports],
    ["component.tsx", []],
    ["substitute.tsx", []],
  ]);
  return auditGraph({
    entries: ["entry.tsx"],
    stories,
    support: new Set(["fixture.tsx"]),
    importsOf(file) {
      assert.ok(graph.has(file), `Missing graph node: ${file}`);
      return graph.get(file);
    },
  });
}

test("accepts a fixture wrapper around a production component", () => {
  assert.deepEqual(inspect(), []);
});

test("rejects an unreachable substitute hidden behind that wrapper", () => {
  assert.ok(
    inspect({ fixtureImports: ["substitute.tsx"] }).some((message) =>
      message.includes("unreachable module: substitute.tsx"),
    ),
  );
});

test("rejects empty discovery rather than reporting success", () => {
  assert.throws(() => inspect({ stories: [] }), /No app stories/u);
});

test("rejects production importing story support", () => {
  assert.ok(
    inspect({ productionImports: ["fixture.tsx"] }).some((message) =>
      message.includes("Production imports story/test support"),
    ),
  );
});

test("rejects support-only stories with no production component", () => {
  assert.ok(
    inspect({ fixtureImports: [] }).some((message) =>
      message.includes("no production JSX component module"),
    ),
  );
});

test("handles fixture cycles without exempting their dependencies", () => {
  assert.ok(
    inspect({
      fixtureImports: ["fixture.tsx", "substitute.tsx"],
    }).some((message) => message.includes("substitute.tsx")),
  );
});

test("excludes type-only edges and includes literal lazy imports", () => {
  assert.deepEqual(
    runtimeSpecifiers(`
      import type { A } from "./type-a";
      import { type B } from "./type-b";
      export type { C } from "./type-c";
      import { type D, Component } from "./component";
      export { value } from "./values";
      import "./side-effect";
      const lazy = () => import("./lazy");
    `),
    ["./component", "./values", "./side-effect", "./lazy"],
  );
});

test("rejects syntax that cannot be inspected reliably", () => {
  assert.throws(
    () => runtimeSpecifiers("import { broken"),
    /syntactically invalid/u,
  );
});

test("parses valid TypeScript generic arrows with their module extension", () => {
  assert.deepEqual(
    runtimeSpecifiers(
      'import { value } from "./value"; export const identity = <T>(input: T): T => input;',
      "generic.ts",
    ),
    ["./value"],
  );
});

test("keeps JSX parsing when the actual module is TSX", () => {
  assert.deepEqual(
    runtimeSpecifiers(
      'import { Card } from "./card"; export const View = () => <Card label="ready" />;',
      "view.tsx",
    ),
    ["./card"],
  );
});

test("refuses TSX-ambiguous syntax with the module path and location", () => {
  assert.throws(
    () => runtimeSpecifiers("const identity = <T>(input: T): T => input;", "ambiguous.tsx"),
    /Cannot audit syntactically invalid source ambiguous\.tsx:\d+:\d+:/u,
  );
});

test("still refuses malformed TypeScript and identifies its source location", () => {
  assert.throws(
    () => runtimeSpecifiers("export const broken = ;", "invalid.ts"),
    /Cannot audit syntactically invalid source invalid\.ts:\d+:\d+:/u,
  );
});
