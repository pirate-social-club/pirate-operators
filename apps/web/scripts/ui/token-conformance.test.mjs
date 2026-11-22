// Behavior tests for the token-conformance audit script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHexLiterals, isAllowed, scanFiles, ALLOWED } from "./token-conformance.mjs";

test("findHexLiterals catches 3, 4, 6 and 8 digit hex forms", () => {
  const found = findHexLiterals(
    'a { color: #fff; b: #ffff; c: #171B1F; d: #0000000F; e: rgb(1,2,3); f: #262a30 }',
  );
  assert.deepEqual(
    found.map((entry) => entry.literal).sort(),
    ["#0000000F", "#171B1F", "#262a30", "#ffff", "#fff"].sort(),
  );
});

test("findHexLiterals does not flag non-hex ids or short words", () => {
  assert.deepEqual(findHexLiterals('href="#top" id="#settings" x="#gg"'), []);
  assert.deepEqual(findHexLiterals("const zero = 0xff00; notColor(0xdeadbeef)"), []);
});

test("isAllowed matches exact files and named directories only", () => {
  assert.equal(isAllowed("src/styles/document-v1.css", ALLOWED), true);
  assert.equal(isAllowed("src/styles/client.css", ALLOWED), false);
  assert.equal(isAllowed("src/media/reference/src/design-system.ts", ALLOWED), true);
  assert.equal(isAllowed("src/media/reference-capture.tsx", ALLOWED), true);
  assert.equal(isAllowed("src/media/community-ui/song-step.tsx", ALLOWED), false);
});

test("scanFiles reports file, line and literal for product hex", () => {
  const findings = scanFiles({
    "src/karaoke/route-states.tsx": 'const a = "bg-[#20242c]";\nconst b = 2;\nconst c = "#171B1F";',
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, "src/karaoke/route-states.tsx");
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].literal, "#20242c");
  assert.equal(findings[2 - 1].line, 3);
});

test("scanFiles skips named exemptions entirely", () => {
  const files = { "src/media/reference/src/fake.tsx": "color: #fff;" };
  assert.deepEqual(scanFiles(files), []);
});

test("the live allowlist entries name real current reasons", () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.path.startsWith("src/"), entry.path);
    assert.ok(entry.reason.length > 20, entry.path);
  }
});
