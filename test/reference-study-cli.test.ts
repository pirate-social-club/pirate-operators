import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256, toHex } from "viem";
import { referenceResultsMain } from "../harness/reference-results.ts";
import { studyTrace } from "./fixtures/reference-study.ts";

test("reference command help and offline replay never access network and preserve exact evidence bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reference-study-cli-")),
    f = studyTrace();
  f.publish(5);
  const path = join(directory, "input.json"),
    output = join(directory, "evidence");
  await writeFile(path, JSON.stringify(f.snapshot));
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("network_forbidden");
  };
  try {
    const before = await readdir(directory);
    assert.ok((await referenceResultsMain([])).usage);
    assert.deepEqual(await readdir(directory), before);
    const result = await referenceResultsMain([
      "--snapshot",
      path,
      "--output",
      output,
    ]);
    assert.equal(result.publications, 1);
    assert.equal(result.verified, 1);
    const raw = await readFile(join(output, "raw.json"), "utf8"),
      reduced = await readFile(join(output, "reference.json"), "utf8"),
      hashes = JSON.parse(await readFile(join(output, "sha256.json"), "utf8"));
    assert.equal(hashes["raw.json"], sha256(toHex(raw)));
    assert.equal(hashes["reference.json"], sha256(toHex(reduced)));
    assert.equal(result.rawSha256, hashes["raw.json"]);
    await assert.rejects(
      referenceResultsMain(["--snapshot", path, "--output", output]),
      /EEXIST/,
    );
    assert.equal(await readFile(join(output, "raw.json"), "utf8"), raw);
  } finally {
    globalThis.fetch = fetch;
  }
});
test("live reference capture refuses another chain and credential-shaped profile fields before any request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reference-study-profile-")),
    f = studyTrace(),
    path = join(directory, "profile.json");
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("network_must_not_start");
  };
  try {
    await writeFile(
      path,
      JSON.stringify({ ...f.snapshot.profile, chainId: 31337 }),
    );
    await assert.rejects(
      referenceResultsMain(["--read", "--profile", path]),
      /live_chain_must_be_6343/,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...f.snapshot.profile,
        privateKey: "forbidden-fixture-marker",
      }),
    );
    await assert.rejects(
      referenceResultsMain(["--read", "--profile", path]),
      /invalid_public_profile_fields/,
    );
  } finally {
    globalThis.fetch = fetch;
  }
});
