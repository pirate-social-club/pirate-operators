// The forge vectors are the shared builder's output, the contract's Statement
// is the protocol's, and the V4 runtime stays under the EIP-170 limit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import solc from "solc";
import { getAddress } from "viem";
import {
  SIGN_IN_VECTORS_V4_PATH,
  eip55Cases,
  isoCases,
  signInVectorsV4,
  signInVectorsV4Source,
} from "../harness/sign-in-vectors-v4.ts";

test("test/solidity/SignInVectorsV4.sol is what the builder generates now", () => {
  assert.equal(
    readFileSync(SIGN_IN_VECTORS_V4_PATH, "utf8"),
    signInVectorsV4Source(),
    "stale: run node harness/sign-in-vectors-v4.ts --write",
  );
});

test("the vectors carry the EIP-55 and ISO-8601 edge cases", () => {
  const vectors = signInVectorsV4();
  for (const address of eip55Cases) {
    assert.equal(getAddress(address.toLowerCase()), address);
    assert.ok(vectors.some((v) => v.text.includes(`account:\n${address}\n`)), address);
  }
  for (const [, iso] of isoCases)
    assert.ok(vectors.some((v) => v.text.includes(`\nIssued At: ${iso}\nNot Before: ${iso}\n`)), iso);
  assert.ok(vectors.some((v) => v.text.includes("\nNonce: 00000000000000000000000000000000000000000000000000000000000000a1\n")));
  assert.ok(vectors.some((v) => v.text.startsWith("study.example:8443 wants")));
  assert.ok(vectors.some((v) => v.text.includes("\nChain ID: 31337\n")));
  assert.ok(vectors.some((v) => v.text.includes("\nChain ID: 6343\n")));
});

test("the V4 runtime is under the EIP-170 limit with the release compiler settings", { timeout: 120000 }, () => {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "contracts/LearningResultsV4.sol": { content: readFileSync("contracts/LearningResultsV4.sol", "utf8") } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          metadata: { bytecodeHash: "none" },
          outputSelection: { "*": { LearningResultsV4: ["evm.deployedBytecode.object"] } },
        },
      }),
    ),
  );
  const runtime = out.contracts["contracts/LearningResultsV4.sol"].LearningResultsV4.evm.deployedBytecode.object as string;
  assert.ok(runtime.length / 2 < 24576, `runtime ${runtime.length / 2} bytes`);
});
