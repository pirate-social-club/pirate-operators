// Adapted from pirate-web-solid c7cb8783 storybook-a11y-sweep.mjs.
// Pure result checks; importing this module launches no browser.
export const DEFAULT_SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 },
];

export function parseIndex(index) {
  if (!index || typeof index.entries !== "object" || !index.entries) {
    throw new Error("Missing Storybook index entries");
  }
  const stories = Object.values(index.entries).filter((entry) => entry?.type === "story");
  if (!stories.length) throw new Error("Empty Storybook selection");
  const ids = new Set();
  for (const story of stories) {
    if (
      typeof story.id !== "string" || !/^[a-z0-9_-]+$/iu.test(story.id) ||
      typeof story.importPath !== "string" ||
      !/^\.\/src\/.+\.stories\.[cm]?[jt]sx?$/u.test(story.importPath) ||
      ids.has(story.id)
    ) throw new Error("Malformed, duplicate or non-app story index entry");
    ids.add(story.id);
  }
  return stories.sort((a, b) => a.id.localeCompare(b.id));
}

export function sizesFor(metadata, presets) {
  if (!metadata) throw new Error("Missing viewport metadata");
  const parameters = metadata.parameterViewport;
  if (parameters?.defaultViewport) throw new Error("Legacy viewport declaration");
  const requested = metadata.globalsViewport;
  if (requested == null) return DEFAULT_SIZES.map((size) => ({ ...size, global: null }));
  if (typeof requested.value !== "string") throw new Error("Malformed viewport global");
  const option = { ...presets, ...parameters?.options }[requested.value];
  const pixels = (value) => typeof value === "string" && /^\d+px$/u.test(value)
    ? Number.parseInt(value, 10) : NaN;
  let width = pixels(option?.styles?.width);
  let height = pixels(option?.styles?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Unknown or invalid viewport: " + requested.value);
  }
  if (requested.isRotated === true) [width, height] = [height, width];
  return [{ name: requested.value, width, height, global: requested }];
}

export function classify(id, state, size, errors = []) {
  const events = (state?.events ?? []).filter((event) => event.storyId === id);
  const finishes = events.filter((event) =>
    event.name === "storyFinished" && event.payload?.storyId === id);
  const phases = (state?.phases ?? []).filter((phase) => phase.storyId === id);
  const failures = [];
  if (errors.length) failures.push("page_error");
  if (finishes.length !== 1) failures.push("missing_or_duplicate_completion");
  if (events.some((event) => [
    "playFunctionThrewException", "unhandledErrorsWhilePlaying",
    "storyErrored", "storyThrewException",
  ].includes(event.name))) failures.push("render_or_play_failure");

  const renders = phases.filter((phase) => phase.phase === "rendering");
  const plays = phases.filter((phase) => phase.phase === "playing");
  const completed = phases.filter((phase) => phase.phase === "completed");
  if (renders.length !== 1 || plays.length > 1 || completed.length !== 1) {
    failures.push("missing_or_multiple_render_runs");
  }
  const relevant = phases.filter((phase) => [
    "rendering", "playing", "played", "completed",
  ].includes(phase.phase));
  if (!relevant.length || relevant.some((phase) =>
    phase.width !== size.width || phase.height !== size.height)) {
    failures.push("viewport_not_applied");
  }

  const finish = finishes[0]?.payload;
  const reporters = Array.isArray(finish?.reporters) ? finish.reporters : [];
  const axeReporters = reporters.filter((reporter) => reporter?.type === "a11y");
  const axe = axeReporters[0];
  const result = axe?.result;
  if (axeReporters.length !== 1 || !result ||
    !["violations", "passes", "incomplete"].every((key) => Array.isArray(result[key])) ||
    "error" in result) {
    failures.push("missing_or_malformed_a11y");
  } else {
    if (result.violations.length || axe.status !== "passed") failures.push("a11y_failure");
    if (!result.passes.length) failures.push("no_a11y_checks_passed");
  }
  if (reporters.some((reporter) => reporter?.type !== "a11y" && reporter?.status === "failed")) {
    failures.push("reporter_failure");
  }
  if (finish?.status !== "success") failures.push("unsuccessful_story_status");
  return {
    passed: failures.length === 0,
    failures,
    axe: result && {
      violations: Array.isArray(result.violations) ? result.violations.length : null,
      passes: Array.isArray(result.passes) ? result.passes.length : null,
      incomplete: Array.isArray(result.incomplete) ? result.incomplete.length : null,
    },
  };
}

export function summarize(run) {
  const expected = run.expected ?? [];
  const results = run.results ?? [];
  const keys = results.map((result) => result.key);
  const complete = expected.length > 0 &&
    new Set(expected).size === expected.length &&
    keys.length === expected.length &&
    new Set(keys).size === keys.length &&
    expected.every((key) => keys.includes(key));
  return {
    passed: !run.startupError && complete && results.every((result) => result.passed === true),
    complete,
    expected: expected.length,
    recorded: results.length,
    failed: results.filter((result) => result.passed !== true).length,
    incompleteChecks: results.reduce((sum, result) => sum + (result.axe?.incomplete ?? 0), 0),
  };
}
