import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  digest,
  sign,
  verify,
  gate,
  inputHashes,
  jobTransition,
  type JobState,
  type Song,
} from "../packages/protocol/index.ts";
import { accounts, keys } from "../harness/runtime.ts";

test("canonical hashing ignores object insertion order and rejects unsupported values", () => {
  assert.equal(
    canonical({ z: 1, a: { y: 2, x: 3 } }),
    '{"a":{"x":3,"y":2},"z":1}',
  );
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.throws(() => canonical({ invalid: undefined }));
  assert.throws(() => canonical(NaN));
});
test("signatures bind the type, trusted operator and exact body", async () => {
  const evidence = await sign("evidence", { hash: digest("audio") }, keys[2]);
  assert.deepEqual(
    await verify(evidence, "evidence", accounts[2].address),
    evidence.body,
  );
  await assert.rejects(
    verify(
      { ...evidence, body: { hash: digest("edited") } },
      "evidence",
      accounts[2].address,
    ),
  );
  await assert.rejects(verify(evidence, "ticket", accounts[2].address));
  await assert.rejects(verify(evidence, "evidence", accounts[1].address));
});
test("publication binds independent inputs and reuses evidence for a declaration edit", () => {
  const song: Song = {
    communityId: "community",
    audio: "0x010203",
    title: "title",
    lyrics: "lyrics",
    artwork: "cover",
    original: true,
  };
  const records = Object.entries(inputHashes(song)).map(([input, hash]) => ({
    check: input,
    inputHash: hash,
    outcome: input === "audio" ? "no_match" : "allow",
    communityId: "community",
    expiresAt: 100,
  }));
  assert.equal(gate(song, records, 99), "published");
  assert.equal(gate({ ...song, original: false }, records, 99), "hold");
  assert.equal(
    gate(
      song,
      records.map((r) =>
        r.check === "audio" ? { ...r, outcome: "match" } : r,
      ),
      99,
    ),
    "blocked",
  );
  assert.throws(() => gate({ ...song, lyrics: "edited" }, records, 99));
  assert.throws(() => gate(song, records, 100));
});
test("randomized job commands preserve the independently specified action order", () => {
  let seed = 42;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed;
  };
  const actions = ["reserve", "charge", "deliver"] as const;
  for (let run = 0; run < 100; run++) {
    let state: JobState = "new";
    let progress = 0;
    for (let i = 0; i < 30; i++) {
      const action = actions[random() % 3];
      if (progress < 3 && action === actions[progress]) {
        state = jobTransition(state, action);
        progress++;
      } else assert.throws(() => jobTransition(state, action));
    }
    assert.equal(state, ["new", "reserved", "charged", "delivered"][progress]);
  }
});
