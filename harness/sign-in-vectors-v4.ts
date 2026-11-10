// Generates test/solidity/SignInVectorsV4.sol: V4 sign-in texts and digests
// produced by the shared builder (viem createSiweMessage), which the forge
// tests compare with the contract's own rendering. test/learning-sign-in-
// vectors-v4.test.ts regenerates the file in memory and fails if it is stale.
//   node harness/sign-in-vectors-v4.ts --write
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { getAddress, getContractAddress, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import {
  signInIdV4,
  signInMessageV4,
  type SignIn,
  type SignInV4Context,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";

export const SIGN_IN_VECTORS_V4_PATH = "test/solidity/SignInVectorsV4.sol";
/** Forge deploys every test contract here; its first CREATE uses nonce 1. */
export const FORGE_TEST_CONTRACT = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496";
const community = keccak256(stringToHex("community"));
const anvil0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const nonce = "0x7f3e9a1c5b2d4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const at = (iso: string) => BigInt(Date.parse(iso) / 1000);

interface Case {
  name: string;
  origin: string;
  chainId: number;
  learner: Address;
  nonce: Hex;
  issuedAt: bigint;
}
/** The EIP-55 specification's examples, all-digit and all-letter addresses. */
export const eip55Cases = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
  "0x1234567890123456789012345678901234567890",
  "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
] as const;
/** Seconds and the expected Issued At text. */
export const isoCases: [bigint, string][] = [
  [0n, "1970-01-01T00:00:00.000Z"],
  [at("2000-02-29T00:00:00Z"), "2000-02-29T00:00:00.000Z"],
  [at("2024-02-29T23:59:59Z"), "2024-02-29T23:59:59.000Z"],
  [at("2026-12-31T23:59:59Z"), "2026-12-31T23:59:59.000Z"],
  [at("2100-02-28T00:00:00Z"), "2100-02-28T00:00:00.000Z"],
  [at("2100-03-01T00:00:00Z"), "2100-03-01T00:00:00.000Z"],
  [253402300799n, "9999-12-31T23:59:59.000Z"],
];
export function signInVectorCasesV4(): Case[] {
  const base = { origin: "https://community.example", chainId: 6343, learner: anvil0 as Address, nonce: nonce as Hex };
  return [
    { name: "worked example", ...base, issuedAt: 1794240000n },
    { name: "local chain, port, leading-zero nonce", origin: "https://study.example:8443", chainId: 31337, learner: anvil0, nonce: `0x${"00".repeat(31)}a1`, issuedAt: 1794240001n },
    { name: "localhost with port", origin: "https://localhost:8787", chainId: 31337, learner: anvil0, nonce, issuedAt: 1794240002n },
    { name: "long origin", origin: "https://pirate-first-song-20261105.piratesocialclub.workers.dev", chainId: 6343, learner: anvil0, nonce, issuedAt: 1794240003n },
    ...eip55Cases.map((learner, i) => ({ name: `EIP-55 ${learner}`, ...base, learner: learner.toLowerCase() as Address, issuedAt: 1794240100n + BigInt(i) })),
    ...isoCases.map(([issuedAt, iso]) => ({ name: `ISO ${iso}`, ...base, issuedAt })),
  ];
}
export function signInVectorsV4() {
  return signInVectorCasesV4().map((c, i) => {
    const contract = getContractAddress({ from: FORGE_TEST_CONTRACT, nonce: BigInt(i + 1) }).toLowerCase() as Address;
    const context: SignInV4Context = { origin: c.origin, chainId: c.chainId, contract, communityId: community, publicationPolicy: learningV4PublicityPolicy };
    const signIn: SignIn = { learner: c.learner, nonce: c.nonce, issuedAt: c.issuedAt };
    return { ...c, contract, communityId: community, policy: learningV4PublicityPolicy, text: signInMessageV4(context, signIn), digest: signInIdV4(context, signIn) };
  });
}
/**
 * The deployed plain SIWE login (packages/community/accounts.ts) for the forge
 * tests' learner, vm.addr(21), in the forge tests' community.
 */
export function plainLoginV4Vector() {
  const learner = privateKeyToAccount(toHex(21, { size: 32 })).address;
  const time = new Date(1793638800 * 1000);
  return {
    learner,
    text: createSiweMessage({
      address: learner,
      chainId: 6343,
      domain: "community.example",
      uri: "https://community.example",
      version: "1",
      nonce: "a".repeat(64),
      issuedAt: time,
      expirationTime: new Date(time.getTime() + 300_000),
      statement:
        "Sign in to this community. This does not join, create a creator wallet or authorize spending.",
    }),
  };
}
const literal = (s: string) => {
  if (!/^[\x20-\x7e\n]*$/.test(s)) throw new Error("vector_not_ascii");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
};
export function signInVectorsV4Source() {
  const vectors = signInVectorsV4();
  const rows = vectors.map(
    (v, i) => `        // ${v.name}
        v[${i}] = Vector(
            ${literal(v.origin)},
            ${v.chainId},
            ${getAddress(v.contract)},
            ${v.communityId},
            ${v.policy},
            ${getAddress(v.learner)},
            ${v.nonce},
            ${v.issuedAt},
            ${literal(v.text)},
            ${v.digest}
        );`,
  );
  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

// GENERATED by harness/sign-in-vectors-v4.ts from the shared builder
// (packages/protocol/learning-results-v4.ts, viem createSiweMessage). Do not
// edit; test/learning-sign-in-vectors-v4.test.ts fails when this is stale.
library SignInVectorsV4 {
    struct Vector {
        string origin;
        uint256 chainId;
        address deployed;
        bytes32 communityId;
        bytes32 policy;
        address learner;
        bytes32 nonce;
        uint64 issuedAt;
        string text;
        bytes32 digest;
    }

    /// Vector i is the test contract's CREATE with nonce i + 1.
    function all() internal pure returns (Vector[] memory v) {
        v = new Vector[](${vectors.length});
${rows.join("\n")}
    }

    /// The deployed plain SIWE login for vm.addr(21).
    function plainLogin() internal pure returns (address learner, string memory text) {
        return (${getAddress(plainLoginV4Vector().learner)}, ${literal(plainLoginV4Vector().text)});
    }
}
`;
}
if (import.meta.main && process.argv.includes("--write"))
  writeFileSync(SIGN_IN_VECTORS_V4_PATH, signInVectorsV4Source());
