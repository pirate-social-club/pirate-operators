// Read-only interpretation by default; an explicit send stores the verified result, without a provider call.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { curatedCloudContext } from "./curated-release-plan.ts";
import { readOnlyRemoteDb, curatedDatabases } from "./curated-state.ts";
import { cfJson } from "./managed-inventory.ts";
import {
  canonical,
  hashText,
  hashJson,
  insist,
} from "../packages/community/common.ts";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import { publishedKaraokeManifest } from "../packages/karaoke/published-manifest.ts";
import { validateLyrics } from "../packages/community/lyric-manifest.ts";
import { firstSongFixture } from "./karaoke-live.ts";
const send = process.argv.includes("--send"),
  operation =
    "0xd7dac2917880550cb76f3e12a9c23947a6e600f0391c400c0fed93c2e1a4e074";
const cloud = await curatedCloudContext(),
  db = readOnlyRemoteDb(
    cloud.token,
    cloud.accountId,
    curatedDatabases.application,
  );
const row = await db
  .prepare("SELECT * FROM song_alignments WHERE operation_id=?")
  .bind(operation)
  .first<Record<string, unknown>>();
insist(row, "alignment_missing");
const receipt = JSON.parse(String(row.response_json)),
  captured = JSON.parse(String(row.request_json)),
  lyrics = validateLyrics(
    JSON.parse(
      await readFile("fixtures/first-song/lyrics-manifest.json", "utf8"),
    ),
  );
insist(
  receipt.status === 200 &&
    hashText(receipt.body) === receipt.bodySha256 &&
    captured.intent.lyricsSha256 === hashJson(lyrics) &&
    hashJson(lyrics) === firstSongFixture.lyricsSha256,
  "alignment_receipt_not_verified",
);
const result = alignmentResult(
    JSON.parse(receipt.body),
    lyrics,
    captured.intent.durationMs,
  ),
  resultJson = canonical(result),
  manifest = publishedKaraokeManifest(lyrics, result, 10000);
const evidence = {
  mode: send ? "send" : "plan",
  operation,
  receiptSha256: hashText(String(row.response_json)),
  resultSha256: hashText(resultJson),
  providerRequests: 0,
  scoredLines: manifest.lines.length,
  words: result.words.length,
  alignmentMode: result.mode,
};
console.log(JSON.stringify(evidence));
if (send && row.state !== "complete") {
  insist(
    row.state === "unavailable" && row.result_json === null,
    "alignment_state_changed",
  );
  const sql =
    "UPDATE song_alignments SET state='complete',result_json=?,completed_at=? WHERE operation_id=? AND state='unavailable' AND response_json=? AND request_hash=? AND result_json IS NULL";
  const queryFile = join(
    homedir(),
    ".local/state/pirate-learning-results-testnet-20261106/alignment/reconciliation-query.json",
  );
  await writeFile(
    queryFile,
    JSON.stringify([
      {
        sql,
        params: [
          resultJson,
          Date.now(),
          operation,
          row.response_json,
          row.request_hash,
        ],
      },
    ]),
    { mode: 0o600 },
  );
  const reply = await cfJson(
    ["d1", "query", curatedDatabases.application, "--batch", `@${queryFile}`],
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLOUDFLARE_API_TOKEN: cloud.token,
      CLOUDFLARE_ACCOUNT_ID: cloud.accountId,
    },
  );
  insist(
    Array.isArray(reply) &&
      reply.length === 1 &&
      reply[0].success === true &&
      reply[0].meta.changes === 1,
    "alignment_reconciliation_conflict",
  );
  await writeFile(
    "docs/deployments/learning-results-testnet-20261106.alignment-reconciliation.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
} else if (row.state === "complete")
  insist(row.result_json === resultJson, "alignment_result_changed");
