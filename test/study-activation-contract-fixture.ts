// Reconstruct public predecessor runtimes offline; no RPC or private key.
import { readFileSync } from "node:fs";
import solc from "solc";
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { retainedResultsV2 } from "../harness/study-release-profile.ts";
import { firstSong } from "../services/first-song-profile.ts";
const publicDeployment = JSON.parse(
  readFileSync(
    "docs/deployments/first-song-managed-20261105.contracts.json",
    "utf8",
  ),
);
const patch = (
  runtime: Hex,
  refs: Record<string, { start: number; length: number }[]>,
  values: Record<string, Hex>,
) => {
  let code = runtime.slice(2);
  for (const [id, locations] of Object.entries(refs))
    for (const r of locations) {
      const value = values[id];
      if (!value) throw Error("fixture_missing_immutable");
      code =
        code.slice(0, r.start * 2) +
        value.slice(2).padStart(r.length * 2, "0") +
        code.slice((r.start + r.length) * 2);
    }
  return `0x${code}` as Hex;
};
const directoryArtifact = publicDeployment.abis.CommunityDirectoryV1;
const ids = Object.keys(directoryArtifact.immutableReferences).sort(
  (a, b) => Number(a) - Number(b),
);
export const activationDirectoryCode = patch(
  directoryArtifact.runtime,
  directoryArtifact.immutableReferences,
  Object.fromEntries(
    ids.map((id, i) => [
      id,
      [
        publicDeployment.namespace.address,
        publicDeployment.listing.address,
        "0x15180",
      ][i],
    ]),
  ),
);
if (
  keccak256(activationDirectoryCode) !==
  firstSong.directoryProfile.directoryCodeHash
)
  throw Error("fixture_directory_runtime_mismatch");
const path = "contracts/LearningResultsV2.sol";
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { [path]: { content: readFileSync(path, "utf8") } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "cancun",
        metadata: { bytecodeHash: "none" },
        outputSelection: {
          "*": { "*": ["evm.deployedBytecode"], "": ["ast"] },
        },
      },
    }),
  ),
);
const named: Record<string, string> = {};
function visit(value: any) {
  if (value && typeof value === "object") {
    if (
      value.nodeType === "VariableDeclaration" &&
      value.mutability === "immutable"
    )
      named[String(value.id)] = value.name;
    for (const child of Object.values(value))
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
  }
}
visit(output.sources[path].ast);
const domain = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
    ],
    [
      keccak256(
        stringToHex(
          "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        ),
      ),
      keccak256(stringToHex("Pirate Learning Results")),
      keccak256(stringToHex("2")),
      6343n,
      retainedResultsV2.contract,
    ],
  ),
);
const values: Record<string, Hex> = {
  DOMAIN_SEPARATOR: domain,
  communityId: firstSong.directoryProfile.communityId,
  publicityPolicy:
    "0xed087bbce3b42c61236f9c26795f3b1b43e626ded9ac4a75bb97f43138791143",
};
const runtime = output.contracts[path].LearningResultsV2.evm.deployedBytecode;
export const activationV2Code = patch(
  `0x${runtime.object}`,
  runtime.immutableReferences,
  Object.fromEntries(
    Object.entries(named).map(([id, name]) => [id, values[name]]),
  ),
);
if (keccak256(activationV2Code) !== retainedResultsV2.codeHash)
  throw Error("fixture_v2_runtime_mismatch");
