// Written before memoization. Failures: stale equal-size/mtime inputs, caller
// mutation, hidden read/compiler errors, missing output after reuse, or changed
// deployable token behavior. The actual compiler, filesystem and local chain run.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compile } from "../harness/compile.ts";
import { chain } from "../harness/chain.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

test(
  "compiler artifacts preserve deployed behavior across reuse, caller edits and changed or invalid sources",
  { timeout: 120000 },
  async (t) => {
    const cwd = process.cwd();
    const fixture = mkdtempSync(join(tmpdir(), "operators-compiler-contract-"));
    let evm: Awaited<ReturnType<typeof chain>> | undefined;
    try {
      cpSync(join(repo, "contracts"), join(fixture, "contracts"), {
        recursive: true,
      });
      const source = join(fixture, "contracts/test/PaymentToken.sol");
      const original = readFileSync(source, "utf8");
      const imported = join(fixture, "contracts/interfaces/IMegapot.sol");
      const importedSource = readFileSync(imported, "utf8");
      const timestamp = 1_800_000_000;
      utimesSync(source, timestamp, timestamp);
      process.chdir(fixture);
      const first = compile();
      const originalDigest = createHash("sha256")
        .update(JSON.stringify(first))
        .digest("hex");
      first.TestPaymentToken.bytecode = "0x00";
      (first.TestPaymentToken.abi as unknown as unknown[]).length = 0;
      delete first.LearningResultsV4;
      rmSync(join(fixture, ".local/artifacts"), { recursive: true });
      const reused = compile();
      assert.ok(reused.LearningResultsV4);
      assert.ok(reused.TestPaymentToken.abi.length > 0);
      assert.deepEqual(
        JSON.parse(readFileSync(".local/artifacts/contracts.json", "utf8")),
        reused,
      );

      const listener = createServer();
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      const closed = once(listener, "close");
      listener.close();
      await closed;
      evm = await chain(port);
      const deployAndRead = async (artifacts: ReturnType<typeof compile>) => {
        const transaction = await evm!.clients[0].deployContract({
          ...artifacts.TestPaymentToken,
          args: [],
        });
        const receipt = await evm!.publicClient.waitForTransactionReceipt({
          hash: transaction,
        });
        assert.equal(receipt.status, "success");
        assert.ok(receipt.contractAddress);
        return evm!.publicClient.readContract({
          address: receipt.contractAddress,
          abi: artifacts.TestPaymentToken.abi,
          functionName: "decimals",
        });
      };
      assert.equal(await deployAndRead(reused), 6);

      const metadata = statSync(source);
      const changed = original.replace("decimals = 6;", "decimals = 7;");
      assert.notEqual(changed, original);
      assert.equal(Buffer.byteLength(changed), metadata.size);
      writeFileSync(source, changed);
      utimesSync(source, metadata.atime, metadata.mtime);
      assert.equal(statSync(source).mtimeMs, metadata.mtimeMs);
      const revised = compile();
      assert.equal(await deployAndRead(revised), 7);
      const changedDigest = createHash("sha256")
        .update(JSON.stringify(revised))
        .digest("hex");
      assert.notEqual(changedDigest, originalDigest);

      writeFileSync(source, changed.replace("decimals = 7;", "decimals = ;"));
      assert.throws(() => compile(), /ParserError|Expected primary expression/);
      writeFileSync(source, changed);
      unlinkSync(imported);
      assert.throws(() => compile(), /ENOENT/);
      writeFileSync(imported, importedSource);
      assert.equal(await deployAndRead(compile()), 7);

      const proof = {
        schema: "pirate.compiler-artifacts-contract/1",
        status: "passed",
        originalArtifactSha256: originalDigest,
        changedArtifactSha256: changedDigest,
        originalDecimals: 6,
        changedDecimals: 7,
        callerMutationIsolated: true,
        outputRecreated: true,
        invalidSourceRefused: true,
        missingSourceRefused: true,
      };
      mkdirSync(join(repo, ".local"), { recursive: true });
      writeFileSync(
        join(repo, ".local/compiler-artifact-contract.json"),
        JSON.stringify(proof, null, 2) + "\n",
      );
      t.diagnostic(JSON.stringify(proof));
    } finally {
      if (evm && evm.child.exitCode === null && evm.child.signalCode === null) {
        const stopped = once(evm.child, "exit");
        evm.child.kill();
        await stopped;
      }
      process.chdir(cwd);
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
