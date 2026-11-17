import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { readWeb2Community } from "../packages/community/web2-directory-reader.ts";
import { communityIpfsTransport } from "../services/community-deployment-profile.ts";
import { web2Other, web2SongChain } from "./fixtures/web2-first-song-chain.ts";

test(
  "long-running first-song fixture retains authenticated configuration history",
  { timeout: 90000 },
  async (t) => {
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "web2-chain-history-"),
    );
    const publicRecognition = {
      schema: "pirate.recognition-profile/1" as const,
      namespace: hashText("configuration-history fixture"),
      origin: "https://recognition.example",
      signer: web2Other.address.toLowerCase(),
      providerBindingSha256: hashText("explicit fixture; no provider requests"),
    };
    const chain = await web2SongChain(
      { ...publicRecognition, sha256: hashJson(publicRecognition) },
      { evidenceDirectory, historyLimit: 20000 },
    );
    t.after(() => chain.close());
    const profile = parseWeb2ProfileDocument(chain.deployment.directoryProfile);
    const read = () =>
      readWeb2Community(
        chain.client,
        profile,
        {
          now: () => BigInt(Math.floor(Date.now() / 1000)),
          maxSafeBlockAgeSeconds: 900n,
        },
        communityIpfsTransport(chain.deployment),
      );
    const before = await read();
    assert.equal(before.eligibility.status, "available");
    await chain.rpc("anvil_mine", ["0x2000", "0x0"]);
    const after = await read();
    assert.equal(after.eligibility.status, "available");
    assert.deepEqual(after.history, before.history);
    assert.equal(
      after.history.at(-1)?.configurationRevision,
      chain.current().configurationRevision,
    );
    const evidence = canonical({
      schema: "pirate.web2-chain-history-check/1",
      minedBlocks: 8192,
      source: profile.directory,
      configurationHistorySha256: hashJson(after.history),
      localFixtureOnly: true,
    });
    await writeFile(
      join(evidenceDirectory, "configuration-history.json"),
      evidence + "\n",
      { mode: 0o600 },
    );
    t.diagnostic(
      `Retained evidence: ${evidenceDirectory}; SHA256 ${hashText(evidence)}`,
    );
  },
);
