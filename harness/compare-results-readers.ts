// Compare independently reduced outputs. Only identical raw evidence crosses
// the two input boundaries; neither reducer receives the other's derived rows.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { firstResultsBoard } from "./first-results-board.ts";
import { referenceResults } from "./reference-results/reduce.ts";
import { build } from "esbuild";

const { values } = parseArgs({
  options: { snapshot: { type: "string" }, output: { type: "string" } },
});
if (!values.snapshot) {
  console.log(
    "--snapshot <raw.json> compares public V2 evidence offline; optional --output <new-directory> preserves both outputs and source hashes.",
  );
  process.exit(0);
}
const raw = await readFile(values.snapshot, "utf8");
const first = await firstResultsBoard(JSON.parse(raw));
const second = referenceResults(JSON.parse(raw));
const projected = {
  rows: second.rows,
  days: second.days,
  scores: second.scores,
  outcomes: second.records
    .map((r) => ({
      key: r.key,
      revision: r.header.revision,
      commitment: r.commitment,
      completedAt: String(r.header.completedAt),
      policy: r.policy,
      status: r.status,
      verified: r.verified,
      lines: r.outcomes,
    }))
    .sort((a, b) => a.key.localeCompare(b.key)),
};
assert.deepEqual(first, projected, "public readers disagree");
const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function sourceGraph(entry: string) {
  const graph = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  return Object.keys(graph.metafile!.inputs).filter(
    (p) => !p.includes("node_modules/"),
  );
}
const paths = [
  ...new Set([
    ...(await sourceGraph("harness/first-results-board.ts")),
    ...(await sourceGraph("harness/reference-results/reduce.ts")),
    ...(await sourceGraph("harness/reference-results-v2.ts")),
    "harness/compare-results-readers.ts",
    "package.json",
    "package-lock.json",
  ]),
].sort();
const sourceFiles = Object.fromEntries(
  await Promise.all(paths.map(async (p) => [p, digest(await readFile(p))])),
);
const snapshot = JSON.parse(raw);
const receipt = {
  schema: "pirate.public-reader-comparison/1",
  equal: true,
  head: snapshot.head,
  evaluationTimestamp: snapshot.evaluationTimestamp,
  rawSha256: digest(raw),
  sourceFiles,
  publications: second.records.length,
  verified: second.records.filter((r) => r.verified).length,
  outcomesCompared: second.records.reduce(
    (sum, r) => sum + r.outcomes.length,
    0,
  ),
  qualifyingPeriodSets: second.days,
  boards: second.rows,
  scope:
    "V2 only. Independent raw decoding/source/policy/correction/SQL reduction; shared wire facts and public transport. No V3 acceptance or proof of honest performance.",
};
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x), 2) +
  "\n";
if (values.output) {
  await mkdir(values.output, { recursive: false });
  await writeFile(values.output + "/first.json", json(first), { flag: "wx" });
  await writeFile(values.output + "/reference.json", json(second), {
    flag: "wx",
  });
  await writeFile(values.output + "/comparison.json", json(receipt), {
    flag: "wx",
  });
}
console.log(json(receipt));
