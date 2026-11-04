import assert from "node:assert/strict";
import { test } from "node:test";
import { CarReader } from "@ipld/car/reader";
import { sha256 } from "multiformats/hashes/sha2";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDirectory } from "../scripts/lib/car.ts";

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), "car-test-"));
  await mkdir(join(dir, "posts/a"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<p>home</p>");
  await writeFile(join(dir, "posts/a/index.html"), "<p>a</p>");
  await writeFile(join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  return dir;
}

test("packing is deterministic and every block matches its CID", async () => {
  const dir = await fixtureDir();
  try {
    const first = await packDirectory(dir);
    const second = await packDirectory(dir);
    assert.equal(first.rootCid, second.rootCid);
    assert.equal(first.carSha256, second.carSha256);
    assert.match(first.rootCid, /^bafy/);
    const reader = await CarReader.fromBytes(first.car);
    assert.deepEqual((await reader.getRoots()).map(String), [first.rootCid]);
    let blocks = 0;
    for await (const block of reader.blocks()) {
      blocks++;
      const digest = await sha256.digest(block.bytes);
      assert.deepEqual(digest.bytes, block.cid.multihash.bytes, `block ${block.cid} hashes to its CID`);
    }
    assert.equal(blocks, first.blockCount);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
