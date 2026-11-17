import {
  createWriteStream,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { junit, spec } from "node:test/reporters";

async function main() {
  // Membership stays identical to Node's sorted positional four-way sharding.
  // Timing hints may change order only, never selection or timeout policy.
  const match = /^([1-4])\/4$/.exec(process.env.TEST_SHARD ?? "");
  if (!match || process.argv.length !== 2)
    throw new Error("Expected TEST_SHARD=1/4 through 4/4 and no arguments");
  const index = Number(match[1]);
  const inventory = globSync("test/*.test.ts").sort();
  if (
    inventory.length === 0 ||
    inventory.some((file) => !statSync(file).isFile())
  ) {
    throw new Error("Root test inventory is empty or contains a non-file");
  }
  const hints = JSON.parse(
    readFileSync(
      new URL("./root-test-durations.json", import.meta.url),
      "utf8",
    ),
  );
  if (
    hints.schema !== 1 ||
    !hints.seconds ||
    typeof hints.seconds !== "object" ||
    Array.isArray(hints.seconds)
  ) {
    throw new Error("Invalid root test duration hints");
  }
  for (const [file, seconds] of Object.entries(hints.seconds)) {
    if (
      !/^test\/[^/]+\.test\.ts$/.test(file) ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      throw new Error("Invalid root test duration entry");
    }
  }
  const files = inventory.filter((_, position) => position % 4 === index - 1);
  if (files.length === 0) throw new Error("Selected root test shard is empty");
  files.sort(
    (a, b) =>
      (hints.seconds[b] ?? 0) - (hints.seconds[a] ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );

  mkdirSync(".local", { recursive: true });
  writeFileSync(
    `.local/root-test-plan-${index}.json`,
    JSON.stringify(
      {
        schema: 1,
        shard: `${index}/4`,
        concurrency: 2,
        isolation: "process",
        inventory,
        files,
        durationSourceRuns: hints.sourceRuns,
      },
      null,
      2,
    ) + "\n",
  );

  const controller = new AbortController();
  // Separate object-mode branches ensure each reporter receives every event.
  const specEvents = new PassThrough({ objectMode: true });
  const junitEvents = new PassThrough({ objectMode: true });
  const reports = Promise.all([
    pipeline(specEvents, new spec(), process.stdout, { end: false }),
    pipeline(
      junitEvents,
      junit,
      createWriteStream(`.local/root-tests-${index}.xml`),
    ),
  ]);
  // Reporter failure cancels the same run and remains a nonzero result.
  reports.catch(() => controller.abort());
  try {
    run({
      files,
      concurrency: 2,
      isolation: "process",
      forceExit: false,
      signal: controller.signal,
      setup(stream) {
        stream.on("test:fail", () => {
          process.exitCode = 1;
        });
        stream.on("error", (error) => {
          process.exitCode = 1;
          specEvents.destroy(error);
          junitEvents.destroy(error);
          controller.abort();
        });
        stream.pipe(specEvents);
        stream.pipe(junitEvents);
      },
    });
    await reports;
  } catch (error) {
    controller.abort();
    specEvents.destroy(error);
    junitEvents.destroy(error);
    await reports.catch(() => {});
    throw error;
  }
  if (statSync(`.local/root-tests-${index}.xml`).size === 0)
    throw new Error("Empty root test report");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
