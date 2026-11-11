import type { Address, PublicClient } from "viem";
import { bytes32, insist } from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { verifyDanceSourceAt } from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import type { DanceFence, DancePorts } from "../packages/dance/contracts.ts";
import { danceId, danceTime } from "../packages/dance/validation.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";

interface CapturedAuthorization {
  accountId: string;
  wallet: string;
  authorizationId: string;
  atMs: number;
}
const where = `a.authorization_id=? AND a.account_id=? AND a.subject=?
  AND a.state='recorded' AND a.issued_at>0 AND a.issued_at*1000<=?
  AND EXISTS(SELECT 1 FROM application_identity i WHERE i.id=1 AND i.community_id=?)
  AND EXISTS(SELECT 1 FROM credential_bindings b
    WHERE b.account_id=a.account_id AND b.namespace='moss' AND b.network=6343
      AND b.subject=a.subject)
  AND NOT EXISTS(SELECT 1 FROM learning_settings s WHERE s.account_id=a.account_id
    AND (s.public_results_withdrawn_at IS NOT NULL OR a.issued_at*1000<=s.last_withdrawn_at))`;

/** This is the original exact authorization, never the most recent sign-in.
 * The chain observation and the local guard do different jobs: the same D1
 * write that accepts the intent evaluates the returned local predicate again. */
export function capturedDanceAuthorization(input: {
  db: D1Database;
  source: DanceCanonicalSource;
  client: PublicClient;
}) {
  const { db, source, client } = input;
  const rpc = danceReadPort(client);
  return async (fact: CapturedAuthorization): Promise<DanceFence> => {
    const account = danceId(fact.accountId);
    const wallet = address(fact.wallet.toLowerCase());
    const auth = bytes32(fact.authorizationId);
    const time = danceTime(fact.atMs);
    const values = [auth, account, wallet, time, source.domain.communityId];
    const readLocal = () =>
      db
        .prepare(
          `SELECT a.issued_at FROM learning_authorizations a WHERE ${where}`,
        )
        .bind(...values)
        .first<{ issued_at: number }>();
    const before = await readLocal();
    insist(
      before && Number.isSafeInteger(before.issued_at),
      "dance_capture_authorization_changed",
      403,
    );
    insist(
      source.domain.chainId === 6343n && (await rpc.chainId()) === 6343,
      "dance_wrong_chain",
      503,
    );
    const safe = await rpc.safe();
    await verifyDanceSourceAt(rpc, source, safe.number);
    const read = {
      address: source.pin.v4,
      abi: resultsV4Abi,
      blockNumber: safe.number,
    } as const;
    const [owner, issued, since, revoked] = await Promise.all([
      client.readContract({
        ...read,
        functionName: "authorizationLearner",
        args: [auth],
      }),
      client.readContract({
        ...read,
        functionName: "authorizationIssuedAt",
        args: [auth],
      }),
      client.readContract({
        ...read,
        functionName: "authorizedSince",
        args: [wallet as Address],
      }),
      client.readContract({
        ...read,
        functionName: "revokedAt",
        args: [wallet as Address],
      }),
    ]);
    insist(
      owner.toLowerCase() === wallet &&
        issued === BigInt(before.issued_at) &&
        since > 0n &&
        since <= issued &&
        revoked < issued &&
        issued * 1000n <= BigInt(time),
      "dance_capture_authorization_changed",
      403,
    );
    const [block, after] = await Promise.all([
      rpc.block(safe.number),
      readLocal(),
    ]);
    insist(
      block.number === safe.number &&
        block.hash === safe.hash &&
        block.timestamp === safe.timestamp,
      "dance_authorization_anchor_changed",
      503,
    );
    insist(
      after?.issued_at === before.issued_at,
      "dance_capture_authorization_changed",
      403,
    );
    return {
      sql: `EXISTS(SELECT 1 FROM learning_authorizations a WHERE ${where} AND a.issued_at=?)`,
      values: [...values, before.issued_at],
    };
  };
}

export function danceV4AuthorizationPorts(
  input: Parameters<typeof capturedDanceAuthorization>[0],
): Pick<DancePorts, "authorization" | "reviewerAuthorization"> {
  const capture = capturedDanceAuthorization(input);
  return {
    authorization: (c) => {
      insist(
        c.communityId === input.source.domain.communityId &&
          c.source.sourceHash === input.source.sourceHash,
        "dance_canonical_source_changed",
        503,
      );
      return capture({
        accountId: c.learner.accountId,
        wallet: c.learner.wallet,
        authorizationId: c.learner.authorizationId,
        atMs: c.reservedAtMs,
      });
    },
    reviewerAuthorization: (reviewer, intentAcceptedAtMs) =>
      capture({
        accountId: reviewer.accountId,
        wallet: reviewer.wallet,
        authorizationId: reviewer.authorizationId,
        atMs: intentAcceptedAtMs,
      }),
  };
}
