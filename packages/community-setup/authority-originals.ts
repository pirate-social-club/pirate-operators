import { hashMessage } from "viem";
import { check } from "../protocol/index.ts";
import { readSignInMessageV4 } from "../protocol/learning-results-v4.ts";
import type { AuthorityAction } from "./authority-ledger.ts";

/** Used verbatim by the partial index and its bounded invalid-row query.
 * Canonical SIWE/hash checks run in JS on each <=50-row keyset page. */
export const INVALID_AUTHORITY_ORIGINAL = `COALESCE((
 typeof(authorization_id)='text' AND length(authorization_id)=66 AND substr(authorization_id,1,2)='0x'
 AND substr(authorization_id,3) NOT GLOB '*[^0-9a-f]*'
 AND typeof(subject)='text' AND length(subject)=42 AND substr(subject,1,2)='0x' AND substr(subject,3) NOT GLOB '*[^0-9a-f]*'
 AND typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254740
 AND typeof(authority_epoch)='integer' AND authority_epoch BETWEEN 0 AND 9007199254740991
 AND typeof(message)='text' AND length(message) BETWEEN 1 AND 32768
 AND typeof(sign_in_json)='text' AND length(sign_in_json)<=4096 AND json_valid(sign_in_json)
 AND typeof(signature)='text' AND length(signature) BETWEEN 4 AND 32768 AND length(signature)%2=0
 AND substr(signature,1,2)='0x' AND substr(signature,3) NOT GLOB '*[^0-9a-fA-F]*'
 AND typeof(policy_hash)='text' AND length(policy_hash)=66 AND substr(policy_hash,1,2)='0x'
 AND substr(policy_hash,3) NOT GLOB '*[^0-9a-f]*' AND policy_version=4
),0)=0`;
export const INVALID_AUTHORITY_ORIGINAL_QUERY = `SELECT 1 FROM learning_authorizations INDEXED BY learning_authorizations_invalid_original
 WHERE account_id=? AND ${INVALID_AUTHORITY_ORIGINAL} LIMIT 1`;
export const AUTHORITY_ORIGINAL_PAGE_QUERY = `SELECT authorization_id,account_id,subject,issued_at,authority_epoch,message,sign_in_json,signature,policy_hash,policy_version
 FROM learning_authorizations INDEXED BY learning_authorizations_discovery
 WHERE account_id=?1 AND authority_epoch<?2 AND authorization_id>?3 ORDER BY authorization_id LIMIT 50`;

export interface RetainedAuthorityOriginal {
  authorization_id: `0x${string}`;
  account_id: string;
  subject: string;
  issued_at: number;
  authority_epoch: number;
  message: string;
  sign_in_json: string;
  signature: string;
  policy_hash: string;
  policy_version: number;
}
/** Identity validation of an already admitted/verified signature. Reuses the
 * canonical V4 parser; it does NOT replace MOSS admission verification with
 * EOA-only recovery or contact a live wallet/provider. */
export function validateAuthorityOriginal(
  row: RetainedAuthorityOriginal,
  action: AuthorityAction,
  identity: { community_id: string; community_origin: string },
) {
  const read = readSignInMessageV4(row.message);
  check(
    read &&
      hashMessage(row.message) === row.authorization_id &&
      identity.community_id === action.scope.communityId &&
      read.context.communityId === identity.community_id &&
      read.context.origin === identity.community_origin &&
      read.context.chainId === action.target.chainId &&
      action.target.version === 4 &&
      read.context.contract === action.target.contract.toLowerCase() &&
      row.account_id === action.accountId &&
      read.signIn.learner.toLowerCase() === row.subject &&
      Number.isSafeInteger(row.issued_at * 1000) &&
      read.signIn.issuedAt === BigInt(row.issued_at) &&
      read.context.publicationPolicy === row.policy_hash &&
      row.policy_version === 4,
    "authority_original_mismatch",
  );
  const compact: unknown = JSON.parse(row.sign_in_json);
  check(
    compact && typeof compact === "object" && !Array.isArray(compact),
    "authority_original_mismatch",
  );
  const args = compact as Record<string, unknown>;
  check(
    Object.keys(args).sort().join() === "issuedAt,learner,nonce" &&
      typeof args.learner === "string" &&
      args.learner.toLowerCase() === row.subject &&
      args.nonce === read.signIn.nonce &&
      args.issuedAt === String(read.signIn.issuedAt) &&
      /^0x[0-9a-f]+$/i.test(row.signature) &&
      row.signature.length % 2 === 0 &&
      row.signature.length <= 32768,
    "authority_original_mismatch",
  );
}
