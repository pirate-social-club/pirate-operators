import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import solc from "solc";
import type { Abi, Hex } from "viem";

type Artifacts = Record<string, { abi: Abi; bytecode: Hex }>;
let lastCompilation:
  | { input: string; version: string; artifacts: string }
  | undefined;

export function compile(): Artifacts {
  const names = [
    "contracts/RewardPool.sol",
    "contracts/test/Providers.sol",
    "contracts/test/PaymentToken.sol",
    "contracts/test/MockAccount.sol",
    "contracts/test/ReplaySafeAccount.sol",
    "contracts/OperatorPayments.sol",
    "contracts/LearningRecords.sol",
    "contracts/LearningResultsV2.sol",
    "contracts/LearningResultsV3.sol",
    "contracts/LearningResultsV4.sol",
    "contracts/interfaces/IMegapot.sol",
  ];
  // Always reread content before reuse, including in a different working tree.
  const sources = Object.fromEntries(
    names.map((name) => [name, { content: readFileSync(name, "utf8") }]),
  );
  const input = JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      metadata: { bytecodeHash: "none" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  });
  const version = solc.version();
  let serialized =
    lastCompilation?.input === input && lastCompilation.version === version
      ? lastCompilation.artifacts
      : undefined;
  if (serialized === undefined) {
    const output = JSON.parse(solc.compile(input)) as {
      errors?: { severity: string; formattedMessage: string }[];
      contracts: Record<
        string,
        Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>
      >;
    };
    const errors = output.errors?.filter((e) => e.severity === "error");
    if (errors?.length)
      throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
    const artifacts = Object.fromEntries(
      Object.values(output.contracts).flatMap((contracts) =>
        Object.entries(contracts).map(([name, contract]) => [
          name,
          {
            abi: contract.abi,
            bytecode: `0x${contract.evm.bytecode.object}` as Hex,
          },
        ]),
      ),
    );
    serialized = JSON.stringify(artifacts, null, 2);
    // One process-local entry, populated only after successful compilation.
    // New deployment processes still compile from their current source.
    lastCompilation = { input, version, artifacts: serialized };
  }
  mkdirSync(".local/artifacts", { recursive: true });
  writeFileSync(".local/artifacts/contracts.json", serialized);
  // Callers own their result, including nested ABI data, on every invocation.
  return JSON.parse(serialized) as Artifacts;
}
