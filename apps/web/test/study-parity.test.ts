// Original central reference: c7cb87835a1858a1955c820b03d566365e6d42db.
// studying-surface.tsx and studying-model.ts include reviewed local owner/Paper
// corrections from 93a6134cfe7ca344a61cd81f88da65fe4979be9a. The remaining
// pin retains the central-reference baseline; durable adapters are separate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = [
  {
    file: "studying-surface.tsx",
    sha256: "31a22d3a2dec7c9b13f75240273a1c47b12c3aee8bb4d252df5bb125ea20bf9d",
  },
  {
    file: "studying-model.ts",
    sha256: "bfa0720d4fb9b30a25fc66233744b010d9f57bfcd27fe3a5cf35b59a039db815",
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
test("Study presentation matches c7 baseline plus reviewed owner/Paper corrections 93a6134", async () => {
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
