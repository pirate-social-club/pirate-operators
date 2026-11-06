// Wire facts only are shared with the production reader. No reduction helpers.
import { parseAbi, hexToBytes, type Address, type Hex } from "viem";
import { resultsV3Abi } from "../../packages/protocol/learning-results-v3.ts";
import { base32 } from "multiformats/bases/base32";
import {
  resultsAbi,
  type TerminalResult,
} from "../../packages/protocol/learning-results.ts";
export type Header = TerminalResult;
export function resultManifestUri(hash: Hex) {
  return `ipfs://${base32.encode(Uint8Array.from([1, 0x55, 0x12, 0x20, ...hexToBytes(hash)]))}`;
}
export const abi = [
  ...resultsAbi,
  ...parseAbi([
    "event ControllerChanged(address controller)",
    "event GraderSet(address indexed grader,uint8 indexed activity,bool allowed)",
    "event ResultInvalidated(bytes32 indexed sessionId,uint32 indexed revision,bytes32 reason)",
  ]),
] as const;
export const v3Abi = [
  ...resultsV3Abi,
  ...parseAbi([
    "event ControllerChanged(address controller)",
    "event GraderSet(address indexed grader,uint8 indexed activity,bool allowed)",
    "event ResultInvalidated(bytes32 indexed sessionId,uint32 indexed revision,bytes32 reason)",
  ]),
] as const;
export function abiFor(version: 2 | 3 = 2) {
  if (version !== 2 && version !== 3)
    throw Error("reference_unsupported_contract_version");
  return version === 3 ? v3Abi : abi;
}
export interface ContractProfile {
  version?: 2 | 3;
  address: Address;
  fromBlock: string;
  codeHash: Hex;
}
export interface ReferenceProfile {
  chainId: 6343 | 31337;
  communityId: Hex;
  registry: Address;
  directory: ContractProfile;
  posts: ContractProfile;
  results: ContractProfile[];
}
export interface RawLog {
  address: Address;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  data: Hex;
  topics: [Hex, ...Hex[]];
  removed: boolean;
}
export interface RawBlock {
  number: string;
  hash: Hex;
  timestamp: string;
}
export interface RawReceipt {
  hash: Hex;
  blockNumber: string;
  blockHash: Hex;
  status: "success" | "reverted";
  logs: RawLog[];
}
export interface RawContractState {
  version?: 2 | 3;
  address: Address;
  communityId: Hex;
  publicityPolicy: Hex;
  commitments: Record<string, Hex>;
  policies: Record<string, Hex>;
}
export interface ReferenceSnapshot {
  schema: "pirate.reference-public-evidence/1";
  profile: ReferenceProfile;
  head: RawBlock;
  checkedHeadHash: Hex;
  evaluationTimestamp: number;
  codes: Record<string, Hex>;
  logs: RawLog[];
  blocks: Record<string, RawBlock>;
  receipts: Record<string, RawReceipt>;
  documents: Record<string, Hex>;
  unavailable: string[];
  directoryState: Record<string, unknown>;
  contractStates: RawContractState[];
}
