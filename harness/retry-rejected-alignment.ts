// Task-scoped repair after the owner confirmed billing was paid. Plan by default.
// Preserves the exact rejected row; never retries an unknown or successful request.
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { curatedCloudContext } from "./curated-release-plan.ts";
import { readOnlyRemoteDb, curatedDatabases } from "./curated-state.ts";
import { cfJson } from "./managed-inventory.ts";
import {
  canonical,
  hashJson,
  hashText,
  insist,
} from "../packages/community/common.ts";
import {
  alignmentRequestMessage,
  type AlignmentRequest,
} from "../services/karaoke-song.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  durableJson,
  privateJson,
  replacePrivateJson,
  digest,
} from "./private-json.ts";
const send = process.argv.includes("--send"),
  directory = join(
    homedir(),
    ".local/state/pirate-learning-results-testnet-20261106/alignment/billing-recovery",
  );
const operation =
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
  body = JSON.parse(receipt.body);
insist(
  row.state === "unavailable" &&
    receipt.status === 401 &&
    body.detail?.status === "payment_issue" &&
    hashText(receipt.body) === receipt.bodySha256,
  "not_a_known_billing_rejection",
);
console.log(
  JSON.stringify({
    mode: send ? "send" : "plan",
    operation,
    priorReceiptSha256: hashJson(receipt),
    priorHttpStatus: 401,
    recoveryRequests: 1,
    totalAlignmentRequestLimit: 2,
    sharedDailyLimit: 10,
    authorization:
      "workspace_owner confirmed billing paid; existing testnet launch task",
  }),
);
if (!send) process.exit(0);
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "recovery.json");
insist(!(await privateJson(file)), "recovery_already_allocated_reconcile_only");
const path = join(
    homedir(),
    ".config/pirate-registry/megaeth-testnet-operator.json",
  ),
  stat = await lstat(path);
insist(
  stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid!(),
  "controller_key_not_private",
);
const key = JSON.parse(await readFile(path, "utf8"));
insist(key.chainId === 6343, "wrong_chain");
const account = privateKeyToAccount(key.privateKey);
insist(
  account.address.toLowerCase() ===
    "0x274f223809f00cbdd51d05de3abc8fd3368fde16",
  "controller_changed",
);
const original = JSON.parse(String(row.request_json));
const request: AlignmentRequest = {
  schema: "pirate.song-alignment-request/1",
  ...original.identity,
  lyricsSha256: original.intent.lyricsSha256,
  vocalSha256: original.intent.vocalSha256,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const signed = {
  request,
  signature: await account.signMessage({
    message: alignmentRequestMessage(request),
  }),
};
const grantHash = hashJson(signed),
  captured = canonical({
    identity: original.identity,
    grantHash,
    intent: original.intent,
  }),
  requestHash = hashText(captured);
await durableJson(file, {
  prior: row,
  signed,
  grantHash,
  requestHash,
  captured,
  maximumRecoveryRequests: 1,
  state: "allocated",
});
const sql =
  "UPDATE song_alignments SET grant_hash=?,request_hash=?,request_json=?,state='planned',execution_token=NULL,response_json=NULL,result_json=NULL,started_at=NULL,completed_at=NULL WHERE operation_id=? AND state='unavailable' AND response_json=? AND request_hash=?";
const result = await cfJson(
  [
    "d1",
    "query",
    curatedDatabases.application,
    "--body",
    JSON.stringify({
      sql,
      params: [
        grantHash,
        requestHash,
        captured,
        operation,
        row.response_json,
        row.request_hash,
      ],
    }),
  ],
  {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLOUDFLARE_API_TOKEN: cloud.token,
    CLOUDFLARE_ACCOUNT_ID: cloud.accountId,
  },
);
insist(
  Array.isArray(result) &&
    result.length === 1 &&
    result[0].success === true &&
    result[0].meta.changes === 1,
  "billing_recovery_compare_and_set_failed",
);
const previous = await readFile(file);
await replacePrivateJson(
  file,
  {
    prior: row,
    signed,
    grantHash,
    requestHash,
    captured,
    maximumRecoveryRequests: 1,
    state: "sent",
  },
  digest(previous),
);
const response = await fetch(
  firstSong.origin + "/api/operator/song-alignment",
  {
    method: "POST",
    headers: { origin: firstSong.origin, "content-type": "application/json" },
    body: JSON.stringify(signed),
    signal: AbortSignal.timeout(180000),
  },
);
const answer = (await response.json()) as { state?: string; error?: string };
await writeFile(
  join(directory, "response.json"),
  JSON.stringify({ http: response.status, answer }, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    http: response.status,
    state: answer.state,
    error: answer.error,
  }),
);
insist(
  response.ok && answer.state === "complete",
  "recovery_not_complete_reconcile_only",
);
