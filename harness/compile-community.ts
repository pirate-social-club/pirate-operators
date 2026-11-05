import { readFileSync } from "node:fs";
import solc from "solc";
import { keccak256, stringToHex, type Abi, type Hex } from "viem";

export interface CommunityArtifact {
  abi: Abi;
  bytecode: Hex;
  runtime: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}
/** Reproducible, independent first-song profile. No deployment is performed. */
export function compileCommunity() {
  const paths = [
    "contracts/community/CommunityDirectoryV1.sol",
    "contracts/community/CommunityPostsV1.sol",
    "contracts/community/PublicationReference.sol",
    "contracts/interfaces/community/ICommunityDirectoryV1.sol",
    "contracts/interfaces/community/ICommunityPostsV1.sol",
    "contracts/testnet/DisabledDiscoveryAuthority.sol",
  ];
  const sources = Object.fromEntries(
    paths.map((path) => [path, { content: readFileSync(path, "utf8") }]),
  );
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none", appendCBOR: false },
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
        ],
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify({ language: "Solidity", sources, settings })),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<
        string,
        {
          abi: Abi;
          evm: {
            bytecode: { object: string };
            deployedBytecode: {
              object: string;
              immutableReferences: CommunityArtifact["immutableReferences"];
            };
          };
        }
      >
    >;
  };
  if (output.errors?.some((e) => e.severity === "error"))
    throw new Error("community_contract_compilation_failed");
  const artifacts: Record<string, CommunityArtifact> = {};
  for (const contracts of Object.values(output.contracts))
    for (const [name, value] of Object.entries(contracts)) {
      artifacts[name] = {
        abi: value.abi,
        bytecode: `0x${value.evm.bytecode.object}`,
        runtime: `0x${value.evm.deployedBytecode.object}`,
        immutableReferences: value.evm.deployedBytecode.immutableReferences,
      };
    }
  return {
    compiler: solc.version(),
    settings,
    sources: Object.fromEntries(
      Object.entries(sources).map(([path, value]) => [
        path,
        keccak256(stringToHex(value.content)),
      ]),
    ),
    artifacts,
  };
}
export function runtimeMatches(actual: Hex, artifact: CommunityArtifact) {
  const blank = (hex: Hex) => {
    let value = hex.slice(2);
    for (const reference of Object.values(artifact.immutableReferences).flat())
      value =
        value.slice(0, reference.start * 2) +
        "0".repeat(reference.length * 2) +
        value.slice((reference.start + reference.length) * 2);
    return value;
  };
  return (
    actual.length === artifact.runtime.length &&
    blank(actual) === blank(artifact.runtime)
  );
}
