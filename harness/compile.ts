import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import solc from "solc";
import type { Abi, Hex } from "viem";

export function compile() {
  const names = [
    "contracts/RewardPool.sol",
    "contracts/test/Providers.sol",
    "contracts/test/PaymentToken.sol",
    "contracts/test/MockAccount.sol",
    "contracts/OperatorPayments.sol",
    "contracts/LearningRecords.sol",
    "contracts/LearningResultsV2.sol",
    "contracts/LearningResultsV3.sol",
    "contracts/interfaces/IMegapot.sol",
  ];
  const sources = Object.fromEntries(
    names.map((name) => [name, { content: readFileSync(name, "utf8") }]),
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          metadata: { bytecodeHash: "none" },
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  ) as {
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
  mkdirSync(".local/artifacts", { recursive: true });
  writeFileSync(
    ".local/artifacts/contracts.json",
    JSON.stringify(artifacts, null, 2),
  );
  return artifacts;
}
