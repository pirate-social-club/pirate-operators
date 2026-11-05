import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedSourceHashes } from "../harness/content-qualification-source.ts";
test("the plan binds transitive owned runtime imports and detects a new dependency or changed leaf", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "content-source-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(join(root, "package-lock.json"), "{}"),
    writeFile(
      join(root, "entry.ts"),
      'import {value} from "./middle.ts"; console.log(value);',
    ),
    writeFile(join(root, "middle.ts"), 'export {value} from "./leaf.ts";'),
    writeFile(join(root, "leaf.ts"), "export const value=1;"),
  ]);
  const before = await ownedSourceHashes(root, "entry.ts");
  assert(Object.hasOwn(before, "leaf.ts"));
  await writeFile(join(root, "leaf.ts"), "export const value=2;");
  const after = await ownedSourceHashes(root, "entry.ts");
  assert.notEqual(before["leaf.ts"], after["leaf.ts"]);
  await writeFile(join(root, "new.ts"), "export const value=3;");
  await writeFile(join(root, "middle.ts"), 'export {value} from "./new.ts";');
  const added = await ownedSourceHashes(root, "entry.ts");
  assert(Object.hasOwn(added, "new.ts"));
  assert(!Object.hasOwn(added, "leaf.ts"));
});
test("the actual qualification graph includes the shared protocol module", async () => {
  const graph = await ownedSourceHashes(
    process.cwd(),
    "harness/qualify-content.ts",
  );
  assert(Object.hasOwn(graph, "packages/protocol/index.ts"));
  assert(Object.hasOwn(graph, "harness/content-qualification-transport.ts"));
  assert(Object.hasOwn(graph, "harness/content-qualification-source.ts"));
});
