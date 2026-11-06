// Manual testnet diagnostics. Uses an existing dedicated EOA for temporary
// sign-in and reads only. No enrollment signature, ticket, socket or speech.
import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { firstSong } from "../services/first-song-profile.ts";
import { check } from "../packages/protocol/index.ts";

if (!process.argv.includes("--run")) {
  console.log(
    "Testnet only: --run measures health/feed and authenticated Karaoke prerequisites; no practice or publication.",
  );
  process.exit(0);
}
const samples: {
  path: string;
  status: number;
  ms: number;
  bytes: number;
  timing: string | null;
}[] = [];
async function request(path: string, init: RequestInit = {}) {
  const start = performance.now();
  const response = await fetch(firstSong.origin + path, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(90000),
  });
  const bytes = await response.arrayBuffer();
  samples.push({
    path,
    status: response.status,
    ms: Math.round(performance.now() - start),
    bytes: bytes.byteLength,
    timing: response.headers.get("server-timing"),
  });
  check(response.ok, `latency_request_failed:${path}:${response.status}`);
  return { response, bytes };
}
const json = (bytes: ArrayBuffer) =>
  JSON.parse(new TextDecoder().decode(bytes));
for (let i = 0; i < 3; i++) {
  await request("/health");
  await request("/api/feed");
}
const keyPath = join(
  homedir(),
  ".config/pirate-operators/megaeth-testnet/keys.json",
);
const stat = await lstat(keyPath);
check(
  stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid!(),
  "test_key_not_private",
);
const keys = JSON.parse(await readFile(keyPath, "utf8"));
check(keys.chainId === 6343, "wrong_test_key_chain");
const learner = privateKeyToAccount(keys.keys.purchaseSigner);
const headers = {
  origin: firstSong.origin,
  "content-type": "application/json",
};
const challenge = json(
  (
    await request("/api/auth/challenge", {
      method: "POST",
      headers,
      body: JSON.stringify({ address: learner.address }),
    })
  ).bytes,
);
const verified = await request("/api/auth/verify", {
  method: "POST",
  headers,
  body: JSON.stringify({
    id: challenge.id,
    signature: await learner.signMessage({ message: challenge.message }),
  }),
});
const cookie = verified.response.headers.get("set-cookie")!.split(";")[0]!;
const csrf = json(verified.bytes).csrf;
const postId =
  "0x2ce682013277b160a830fad5fa70734f19831edebce908ea3f8457867355b31e";
try {
  await request(`/api/public/posts/${postId}/karaoke`);
  await request(`/api/karaoke/attempt?postId=${postId}`, {
    headers: { cookie },
  });
  await request(`/api/karaoke/posts/${postId}/instrumental`, {
    headers: { cookie },
  });
  await request("/api/karaoke/enrollment", {
    method: "POST",
    headers: { ...headers, cookie, "x-csrf-token": csrf },
    body: "{}",
  });
} finally {
  await request("/api/logout", {
    method: "POST",
    headers: { ...headers, cookie, "x-csrf-token": csrf },
    body: "{}",
  });
}
console.log(
  JSON.stringify(
    {
      schema: "pirate.community-latency-sample/1",
      observedAt: new Date().toISOString(),
      origin: firstSong.origin,
      scope:
        "Local samples and server timings; startup prerequisites only, excluding ticket, socket, microphone, provider startup and audible playback. No enrollment or public-chain write.",
      samples,
    },
    null,
    2,
  ),
);
