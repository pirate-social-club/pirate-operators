// Version 4: the learner's community sign-in (EIP-712 SignIn) is the standing
// publication permission. Result, outcome and event shapes are V3's.
import { hashTypedData, parseAbi, type Address, type Hex } from "viem";
import { resultStruct, songStruct } from "./learning-results.ts";

export interface SignIn {
  learner: Address;
  communityId: Hex;
  origin: string;
  publicationPolicy: Hex;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
}
export const signInTypes = {
  SignIn: [
    { name: "learner", type: "address" },
    { name: "communityId", type: "bytes32" },
    { name: "origin", type: "string" },
    { name: "publicationPolicy", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export const resultsV4Domain = (chainId: number, verifyingContract: Address) => ({
  name: "Pirate Learning Results",
  version: "4",
  chainId,
  verifyingContract,
});
/** The EIP-712 digest, which is also the authorization id on chain. */
export const signInIdV4 = (chainId: number, contract: Address, message: SignIn) =>
  hashTypedData({
    domain: resultsV4Domain(chainId, contract),
    types: signInTypes,
    primaryType: "SignIn",
    message,
  });
export const signInStruct =
  "struct SignIn { address learner; bytes32 communityId; string origin; bytes32 publicationPolicy; bytes32 nonce; uint64 issuedAt; uint64 expiresAt; }";
export const resultsV4Abi = parseAbi([
  signInStruct,
  songStruct,
  resultStruct,
  "function VERSION() view returns (uint8)",
  "function RELAY_WINDOW() view returns (uint64)",
  "function activatePolicy(uint8 activity,bytes32 policy,string uri,uint64 period)",
  "function policyFor(uint8 activity,uint64 period) view returns (bytes32)",
  "function setGrader(address grader,uint8 activity,bool allowed)",
  "function authorize(SignIn a,bytes signature)",
  "function signInDigest(SignIn a) view returns (bytes32)",
  "function revoke(address learner,uint64 nonce,bytes signature)",
  "function revocationDigest(address learner,uint64 nonce) view returns (bytes32)",
  "function publish(Result r,bytes outcomes)",
  "function correct(Result previous,bytes oldOutcomes,bytes outcomes,uint8 status)",
  "function invalidate(Result previous,bytes outcomes,bytes32 reason)",
  "function commitmentOf(Result r,bytes outcomes) pure returns (bytes32)",
  "function nextNonce(address learner) view returns (uint64)",
  "function authorizedSince(address learner) view returns (uint64)",
  "function revokedAt(address learner) view returns (uint64)",
  "function authorizationLearner(bytes32 id) view returns (address)",
  "function authorizationIssuedAt(bytes32 id) view returns (uint64)",
  "function publicityPolicy() view returns (bytes32)",
  "function communityId() view returns (bytes32)",
  "function commitments(bytes32 sessionId) view returns (bytes32)",
  "event Authorized(address indexed learner,bytes32 indexed authorizationId,string origin,uint64 issuedAt,uint64 authorizedSince)",
  "event Revoked(address indexed learner,uint64 nonce,uint64 revokedAt)",
  "event ResultPublished(bytes32 indexed sessionId,address indexed learner,uint32 indexed revision,Result result,bytes outcomes,bytes32 commitment,address publisher)",
  "event ResultInvalidated(bytes32 indexed sessionId,uint32 indexed revision,bytes32 reason)",
  "event PolicyActivated(uint8 indexed activity,bytes32 indexed policyHash,string policyURI,uint64 effectivePeriod,uint8 clockVersion)",
  "event EligibilityChanged(address indexed learner,bool eligible,uint64 effectiveAt,bytes32 reasonCode)",
]);
