// One controller-authorized alignment and one public timed-manifest pin. Plan by default.
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { curatedCloudContext } from "./curated-release-plan.ts";
import { readOnlyRemoteDb, curatedDatabases } from "./curated-state.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { firstSongFixture } from "./karaoke-live.ts";
import {
  alignmentRequestMessage,
  type AlignmentRequest,
} from "../services/karaoke-song.ts";
import { canonical, digest, check } from "../packages/protocol/index.ts";
import {
  preparePin,
  addPin,
  reconcilePin,
} from "../packages/community/ipfs.ts";
import {
  resultManifestBytes,
  resultManifestUri,
} from "../packages/records/result-manifest.ts";
import {
  durableJson,
  privateJson,
  replacePrivateJson,
  digest as fileHash,
} from "./private-json.ts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";

const send = process.argv.includes("--send"),
  base = join(
    homedir(),
    ".local/state/pirate-learning-results-testnet-20261106/alignment",
  );
const cloud = await curatedCloudContext(),
  db = readOnlyRemoteDb(
    cloud.token,
    cloud.accountId,
    curatedDatabases.application,
  );
const stem = await db
  .prepare(
    "SELECT m.sha256,m.duration_ms,m.byte_length FROM media_stems m JOIN media_submissions s ON s.submission_id=m.submission_id WHERE s.post_id=? AND m.slot='vocals' AND m.state='sealed'",
  )
  .bind(firstSongFixture.postId)
  .first<{ sha256: `0x${string}`; duration_ms: number; byte_length: number }>();
check(
  stem &&
    stem.duration_ms > 0 &&
    stem.duration_ms <= 600000 &&
    stem.byte_length <= 26214400,
  "alignment_input_outside_bound",
);
const old = await db
  .prepare(
    "SELECT state,result_json FROM song_alignments WHERE community_id=? AND post_id=? AND lyrics_revision=1",
  )
  .bind(firstSong.directoryProfile.communityId, firstSongFixture.postId)
  .first<{ state: string; result_json: string | null }>();
console.log(
  JSON.stringify({
    mode: send ? "send" : "plan",
    chainId: 6343,
    postId: firstSongFixture.postId,
    vocal: stem,
    state: old?.state ?? "absent",
    maximumProviderRequests: 1,
    maximumPinAdds: 1,
    sharedDailySpeechCap: 10,
  }),
);
if (!send) process.exit(0);
await mkdir(base, { recursive: true, mode: 0o700 });
async function put(path: string, value: unknown) {
  const previous = await readFile(path).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (previous) await replacePrivateJson(path, value, fileHash(previous));
  else await durableJson(path, value);
}
const requestFile = join(base, "request.json");
if (old?.state !== "complete") {
  check(
    !(await privateJson(requestFile)),
    "alignment_already_dispatched_reconcile_only",
  );
  const path = join(
      homedir(),
      ".config/pirate-registry/megaeth-testnet-operator.json",
    ),
    stat = await lstat(path);
  check(
    stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid!(),
    "controller_key_not_private",
  );
  const key = JSON.parse(await readFile(path, "utf8"));
  check(key.chainId === 6343, "wrong_chain");
  const controller = privateKeyToAccount(key.privateKey);
  check(
    controller.address.toLowerCase() ===
      "0x274f223809f00cbdd51d05de3abc8fd3368fde16",
    "controller_changed",
  );
  const request: AlignmentRequest = {
    schema: "pirate.song-alignment-request/1",
    communityId: firstSong.directoryProfile.communityId,
    postId: firstSongFixture.postId,
    lyricsRevision: 1,
    lyricsSha256: firstSongFixture.lyricsSha256,
    vocalSha256: stem.sha256,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  const signed = {
    request,
    signature: await controller.signMessage({
      message: alignmentRequestMessage(request),
    }),
  };
  await durableJson(requestFile, {
    state: "sent",
    ...signed,
    maximumProviderRequests: 1,
  });
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
  await put(join(base, "response.json"), { http: response.status, answer });
  check(
    response.ok && answer.state === "complete",
    answer.error ?? "alignment_not_complete_reconcile_only",
  );
}
const timedResponse = await fetch(
  firstSong.origin + `/api/public/posts/${firstSongFixture.postId}/karaoke`,
  { signal: AbortSignal.timeout(60000) },
);
check(timedResponse.ok, "timed_manifest_unavailable");
const manifest = (await timedResponse.json()) as KaraokeManifest,
  bytes = resultManifestBytes(manifest),
  hash = digest(manifest),
  pin = await preparePin(bytes, "application/json");
check(pin.uri === resultManifestUri(hash), "manifest_discovery_root_mismatch");
const sdk = await infisicalAuth().client(),
  secret = await sdk
    .secrets()
    .getSecret({
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      secretPath: "/services/api-next",
      secretName: "FILEBASE_IPFS_TOKEN",
      includeImports: false,
      expandSecretReferences: false,
    });
check(secret.secretValue, "pin_secret_missing");
const pinFile = join(base, "pin.json"),
  previous = await privateJson(pinFile);
if (previous) {
  check(previous.hash === hash, "alignment_manifest_changed");
  await reconcilePin(pin, secret.secretValue);
} else {
  await durableJson(pinFile, { state: "sent", hash, pin });
  await addPin(pin, bytes, secret.secretValue, async (receipt) => {
    await put(pinFile, { state: "received", hash, pin, receipt });
  });
}
await put(pinFile, { state: "retained", hash, pin });
const evidence = {
  chainId: 6343,
  postId: firstSongFixture.postId,
  state: "complete",
  vocal: stem,
  lyricsRevision: 1,
  manifestSha256: hash,
  manifestUri: pin.uri,
  manifestBytes: bytes.length,
  scoredLines: manifest.lines.length,
  provider: "ElevenLabs forced alignment",
  maximumProviderRequests: 1,
  maximumPinAdds: 1,
  learnerPerformance: "none",
  manifest,
};
await writeFile(
  "docs/deployments/learning-results-testnet-20261106.alignment.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify({ ...evidence, manifest: undefined }));
