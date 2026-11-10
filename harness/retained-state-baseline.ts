// Offline: derives the public per-row retained-state baseline from a
// preserved read-only capture of both databases. It reads two files and
// writes one; no network, credential or database access. Volatile columns
// and private content are never emitted: immutable and set-once columns are
// digested, and only states, counters, budget keys and amounts are plain.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { sha256 } from "viem";
import {
  CommunityError,
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  assertRetainedPublishedState,
  publishedStateHash,
  publishedStateRepairHash,
  publishedStateRepairPath,
  repairedSummaries,
} from "./published-state.ts";
import {
  deriveSideBaseline,
  retainedStateRules,
  type Rows,
  type Side,
} from "./retained-state-rules.ts";

const publishedStatePath =
  "docs/deployments/first-song-managed-20261105.published-state.json";

/**
 * Re-verifies the capture's rows against the pinned summaries plus the
 * recorded repair, recomputing every summary from the rows, before deriving
 * anything. The capture's own summaries are not trusted.
 */
export function retainedBaselineFromCapture(
  bytes: Uint8Array,
  published: unknown,
  repair: unknown,
) {
  const capture = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  insist(
    capture.schema === "pirate.retained-state-capture/1" &&
      typeof capture.capturedAt === "string" &&
      !Number.isNaN(Date.parse(capture.capturedAt)) &&
      capture.expectedSha256 === publishedStateHash &&
      hashJson(published) === publishedStateHash &&
      capture.repairSha256 === publishedStateRepairHash &&
      hashJson(repair) === publishedStateRepairHash,
    "retained_state_capture_unbound",
    409,
  );
  const sides = {} as Record<Side, ReturnType<typeof deriveSideBaseline>>;
  for (const side of ["application", "managed"] as const) {
    const rows = object(object(capture[side]).rows) as Rows;
    insist(
      canonical(Object.keys(rows).sort()) ===
        canonical(Object.keys(retainedStateRules[side]).sort()),
      "retained_state_capture_tables_changed",
      409,
    );
    const summary = Object.fromEntries(
      Object.entries(rows).map(([table, list]) => {
        insist(Array.isArray(list), "retained_state_capture_invalid", 409);
        return [table, { count: list.length, sha256: hashJson(list) }];
      }),
    );
    assertRetainedPublishedState(
      { rows, summary },
      repairedSummaries(published, side, repair),
      side,
    );
    sides[side] = deriveSideBaseline(side, rows);
  }
  return {
    schema: "pirate.retained-state-baseline/1",
    capturedAt: capture.capturedAt,
    captureSha256: sha256(bytes),
    predecessorStateSha256: publishedStateHash,
    repairSha256: publishedStateRepairHash,
    ...sides,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    const { values } = parseArgs({
      strict: true,
      options: {
        capture: { type: "string" },
        out: { type: "string" },
      },
    });
    insist(
      values.capture && values.out,
      "retained_state_baseline_usage: --capture PRIVATE_CAPTURE.json --out BASELINE.json",
    );
    const record = retainedBaselineFromCapture(
      new Uint8Array(readFileSync(values.capture!)),
      JSON.parse(readFileSync(publishedStatePath, "utf8")),
      JSON.parse(readFileSync(publishedStateRepairPath, "utf8")),
    );
    writeFileSync(values.out!, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        out: values.out,
        captureSha256: record.captureSha256,
        rows: Object.fromEntries(
          (["application", "managed"] as const).map((side) => [
            side,
            Object.fromEntries(
              Object.entries(record[side]).map(([t, list]) => [t, list.length]),
            ),
          ]),
        ),
      }),
    );
  } catch (error) {
    console.error(
      error instanceof CommunityError
        ? error.code
        : error instanceof Error
          ? error.message
          : "retained_state_baseline_failed",
    );
    process.exitCode = 1;
  }
