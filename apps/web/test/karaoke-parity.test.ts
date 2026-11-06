// Centralized presentation pinned independently of the live transport adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = [
  {
    file: "practice-surface.tsx",
    sha256: "9ef381e56abe284bbb31f65ffb1e960f7fe6a090efe47edc4712b60e3c5c9099",
  },
  {
    file: "lyric-stage.tsx",
    sha256: "7faee3ffc385c4454d77f9ad105dd46c32397e83cd54662b8006a2be53edda37",
  },
  {
    file: "activity-progress-header.tsx",
    sha256: "21d8a59d833f2104f4e1681d0927b534866ece71335ec824f2d23487f1e3256a",
  },
  {
    file: "activity-results.tsx",
    sha256: "530fe667f7e261c5f196f4c4ed2d484de41720cf8bd5fb86b94f35ccbd243151",
  },
  {
    file: "results-model.ts",
    sha256: "c2c6e09bbdf321c2e9318fc8719768931fab9daf3c9a03f65ea1baadd40dfec5",
  },
  {
    file: "route-states.tsx",
    sha256: "60b9e83796a5f08c81eca16c5961b17c68079b400dad72974f6f861ef0dbd333",
  },
  {
    file: "scoring-feedback.ts",
    sha256: "5a93ac1f902e535e44166926cbe4ef03de6cf7491cf1027bf74c79907574891e",
  },
  {
    file: "karaoke.css",
    sha256: "cb543aa7dfd1cb15ae6313f04c37be62adcb789902a76855debbd00350b3cc7d",
  },
];
function presentation(source: string) {
  return source
    .replace(/^\/\/ Adopted[^\n]*\n/gm, "")
    .replace(/^\/\* Adopted[^\n]*\n/gm, "")
    .replace(/^(?:import|export type)\s[^;]+;\n/gm, "")
    .replace(/^interface KaraokeScoringState[^\n]*\n/gm, "")
    .trim();
}
test("Karaoke presentation matches centralized c7cb87835a1858a1955c820b03d566365e6d42db", async () => {
  for (const file of files) {
    const source = await readFile(
      new URL(`../src/karaoke/${file.file}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      createHash("sha256").update(presentation(source)).digest("hex"),
      file.sha256,
      `${file.file} drifted`,
    );
  }
});
