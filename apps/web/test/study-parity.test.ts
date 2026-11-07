// The external main-site presentation is pinned independently of the durable adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = [
  {
    file: "studying-surface.tsx",
    sha256: "415cc8caecd53431aa8836a1283e214e8ab16ec68eabba0ba311ed45a865e398",
  },
  {
    file: "studying-model.ts",
    sha256: "14d9b595dc40a17077b88ec12a235615d7070c3ef4fd5e77d0fef6d69550a286",
  },
  {
    file: "studying-route-states.tsx",
    sha256: "3222d9066969254f0ed301980b43ff474fe3f557a8b73ea40a4afb96777ce8c5",
  },
];
function presentation(source: string) {
  return source
    .replace(/^\/\/ Adopted[^\n]*\n/gm, "")
    .replace(/^import\s[^;]+;\n/gm, "")
    .trim();
}
test("Study presentation matches pinned central reference c7cb87835a1858a1955c820b03d566365e6d42db", async () => {
  for (const file of files) {
    const source = await readFile(
      new URL(`../src/study/presentation/${file.file}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      createHash("sha256").update(presentation(source)).digest("hex"),
      file.sha256,
      `${file.file} drifted`,
    );
  }
});
