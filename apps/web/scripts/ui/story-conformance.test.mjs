// Behavior tests for the tier-tag conformance audit script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMeta, scanSources } from "./story-conformance.mjs";

test("parseMeta reads title, tier tag, play presence and page-rule disabling", () => {
  const meta = parseMeta(`const meta = {
  title: "Studying/Flows/Session",
  tags: ["flow"],
  parameters: { layout: "fullscreen" },
} satisfies Meta;`);
  assert.equal(meta.title, "Studying/Flows/Session");
  assert.equal(meta.tag, "flow");
  assert.equal(meta.hasPlay, false);

  const withPlay = parseMeta(`title: "X", tags: ["flow"], play: async () => {}`);
  assert.equal(withPlay.hasPlay, true);

  const fragment = parseMeta(`title: "X", tags: ["part"], rules: [
    { id: "landmark-one-main", enabled: false },
    { id: "page-has-heading-one", enabled: false },
  ]`);
  assert.equal(fragment.disablesPageRules, true);
});

test("a flow without a play function is a violation", () => {
  const findings = scanSources({ "a.stories.tsx": 'title: "X/Flows/Y", tags: ["flow"]' });
  assert.match(findings[0], /play function/);
});

test("a screen disabling any page-level rule is a violation", () => {
  for (const rule of ["landmark-one-main", "page-has-heading-one", "region"]) {
    const findings = scanSources({
      "a.stories.tsx": `title: "X/Screens/Y", tags: ["screen"], rules: [{ id: "${rule}", enabled: false }]`,
    });
    assert.match(findings[0], /fragment/);
  }
});

test("comments and prose do not count as play evidence", () => {
  const findings = scanSources({
    "comment.stories.tsx": 'title: "X/Flows/Y", tags: ["flow"]\n// play: async () => {}',
    "prose.stories.tsx": 'title: "X/Flows/Y", tags: ["flow"], note: "play: async () => {}"',
  });
  assert.equal(findings.length, 2);
  assert.match(findings[0], /play function/);
  assert.match(findings[1], /play function/);
});

test("a flow with a play function and a part pass clean", () => {
  assert.deepEqual(
    scanSources({
      "flow.stories.tsx": 'title: "X/Flows/Y", tags: ["flow"], play: async () => {}',
      "part.stories.tsx": 'title: "X/Parts/Y", tags: ["part"]',
    }),
    [],
  );
});

test("missing or unknown tier tags are violations", () => {
  const findings = scanSources({
    "none.stories.tsx": 'title: "X/Flows/Y"',
    "odd.stories.tsx": 'title: "X/Z/Y", tags: ["widget"]',
  });
  assert.equal(findings.length, 2);
  assert.match(findings[0], /missing a tier tag/);
  assert.match(findings[1], /unknown tier tag/);
});
