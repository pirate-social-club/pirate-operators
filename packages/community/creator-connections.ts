import type { PrivateKeyAccount } from "viem/accounts";
import type { AccountSession } from "./accounts.ts";
import {
  CommunityError,
  canonical,
  equalTokens,
  hashJson,
  hashText,
  insist,
  jsonBody,
  object,
  token,
} from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { signCreatorRequest, type CreatorAction } from "./creator-service.ts";
import {
  creatorServiceOrigin,
  verifyCreatorReceipt,
} from "./creator-receipt.ts";

interface Connection {
  connection_id: string;
  account_id: string;
  session_hash: string;
  state_hash: string;
  state_secret: string | null;
  verifier_hash: string;
  verifier_secret: string | null;
  request_id: string | null;
  receipt_json: string | null;
  expired_receipt_json: string | null;
  retired_reason: string | null;
  expires_at: number;
  consumed: number;
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const secret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const verifierHash = async (value: string) =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
const accountReference = (config: CommunityConfig, session: AccountSession) =>
  hashJson({
    schema: "pirate.creator-account/1",
    communityId: config.communityId,
    accountId: session.account_id,
  });

export interface CreatorConnectionService {
  config: CommunityConfig;
  publisher: PrivateKeyAccount;
  transport?: (request: Request) => Promise<Response>;
  verifyReceipt?: typeof verifyCreatorReceipt;
}
async function callCreator(
  service: CreatorConnectionService,
  action: CreatorAction,
  body: Record<string, unknown>,
) {
  const { config, publisher } = service;
  insist(
    publisher.address.toLowerCase() === config.publisher,
    "creator_publisher_key_mismatch",
    503,
  );
  const issuedAt = Math.floor(Date.now() / 1000),
    wire = await signCreatorRequest(
      publisher,
      {
        action,
        communityId: config.communityId,
        communityOrigin: config.app.origin,
        serviceOrigin: creatorServiceOrigin,
        configurationRevision: config.configurationRevision,
        nonce: `0x${token()}`,
        issuedAt,
        expiresAt: issuedAt + 300,
      },
      body,
    );
  const response = await (service.transport ?? fetch)(
    new Request(
      `${creatorServiceOrigin}/api/communities/${action === "creator_launch" ? "launch" : "exchange"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonical(wire),
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      },
    ),
  );
  const result = await jsonBody(response);
  if (response.status === 409 && result.error === "creator_credential_claimed")
    throw new CommunityError("creator_credential_claimed", 409);
  insist(response.ok, "creator_service_unavailable", 503);
  return result;
}
async function ownedConnection(
  db: D1Database,
  id: string,
  session: AccountSession,
) {
  const row = await db
    .prepare(
      "SELECT * FROM creator_connections WHERE connection_id=? AND account_id=? AND session_hash=?",
    )
    .bind(id, session.account_id, session.session_hash)
    .first<Connection>();
  insist(row, "creator_connection_not_found", 404);
  return row;
}
export async function beginCreatorConnection(
  db: D1Database,
  session: AccountSession,
  service: CreatorConnectionService,
) {
  await db
    .prepare(
      "UPDATE creator_connections SET consumed=1,verifier_secret=NULL WHERE account_id=? AND session_hash=? AND consumed=0 AND expires_at<=?",
    )
    .bind(session.account_id, session.session_hash, Date.now())
    .run();
  let row = await db
    .prepare(
      "SELECT * FROM creator_connections WHERE account_id=? AND session_hash=? AND consumed=0 AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(session.account_id, session.session_hash, Date.now())
    .first<Connection>();
  if (!row) {
    const id = crypto.randomUUID(),
      state = secret(),
      verifier = secret();
    await db
      .prepare(
        "INSERT INTO creator_connections(connection_id,account_id,session_hash,state_hash,verifier_hash,state_secret,verifier_secret,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(
        id,
        session.account_id,
        session.session_hash,
        hashText(state),
        await verifierHash(verifier),
        state,
        verifier,
        Date.now() + 86400_000,
      )
      .run();
    row = await db
      .prepare(
        "SELECT * FROM creator_connections WHERE account_id=? AND session_hash=? AND consumed=0 AND expires_at>? LIMIT 1",
      )
      .bind(session.account_id, session.session_hash, Date.now())
      .first<Connection>();
    insist(row, "creator_connection_not_created", 503);
  }
  insist(
    row.state_secret && row.verifier_secret,
    "creator_connection_not_recoverable",
    409,
  );
  if (!row.request_id) {
    const launched = await callCreator(service, "creator_launch", {
      connectionId: row.connection_id,
      accountRef: accountReference(service.config, session),
      state: row.state_secret,
      verifierHash: row.verifier_hash,
    });
    insist(
      typeof launched.requestId === "string" &&
        /^[a-f0-9]{64}$/.test(launched.requestId),
      "invalid_creator_launch",
      503,
    );
    const expectedId = hashJson({
      communityId: service.config.communityId,
      connectionId: row.connection_id,
    }).slice(2);
    insist(
      launched.requestId === expectedId &&
        launched.url === `${creatorServiceOrigin}/wallet?request=${expectedId}`,
      "invalid_creator_launch",
      503,
    );
    await db
      .prepare(
        "UPDATE creator_connections SET request_id=? WHERE connection_id=? AND (request_id IS NULL OR request_id=?)",
      )
      .bind(expectedId, row.connection_id, expectedId)
      .run();
    row = await ownedConnection(db, row.connection_id, session);
  }
  return {
    connectionId: row.connection_id,
    state: row.state_secret,
    walletOrigin: creatorServiceOrigin,
    url: `${creatorServiceOrigin}/wallet?request=${row.request_id}`,
    expiresAt: row.expires_at,
  };
}
export async function completeCreatorConnection(
  db: D1Database,
  session: AccountSession,
  service: CreatorConnectionService,
  id: string,
  state: string,
) {
  const row = await ownedConnection(db, id, session);
  insist(
    equalTokens(hashText(state), row.state_hash),
    "creator_connection_state_mismatch",
    403,
  );
  if (row.receipt_json)
    return {
      state: "connected",
      creator: object(JSON.parse(row.receipt_json)).payload,
    };
  if (row.expired_receipt_json)
    return { state: "verification_expired", requiresReconnect: true };
  if (row.retired_reason === "creator_credential_claimed")
    return { state: "choose_another_wallet", requiresReconnect: true };
  insist(
    row.expires_at > Date.now() &&
      !row.consumed &&
      row.request_id &&
      row.verifier_secret,
    "creator_connection_expired",
    409,
  );
  const accountRef = accountReference(service.config, session);
  let result: Record<string, unknown>;
  try {
    result = await callCreator(service, "creator_exchange", {
      requestId: row.request_id,
      connectionId: row.connection_id,
      accountRef,
      state,
      verifier: row.verifier_secret,
    });
  } catch (error) {
    if (
      !(error instanceof CommunityError) ||
      error.code !== "creator_credential_claimed"
    )
      throw error;
    await db
      .prepare(
        "UPDATE creator_connections SET retired_reason='creator_credential_claimed',consumed=1,verifier_secret=NULL WHERE connection_id=? AND account_id=? AND session_hash=? AND consumed=0 AND receipt_json IS NULL",
      )
      .bind(id, session.account_id, session.session_hash)
      .run();
    const saved = await ownedConnection(db, id, session);
    if (saved.receipt_json)
      return {
        state: "connected",
        creator: object(JSON.parse(saved.receipt_json)).payload,
      };
    insist(
      saved.retired_reason === "creator_credential_claimed",
      "creator_connection_recovery_conflict",
      409,
    );
    return { state: "choose_another_wallet", requiresReconnect: true };
  }
  if (result.state === "waiting") return { state: "waiting" };
  insist(result.state === "connected", "invalid_creator_exchange", 503);
  const expected = {
      communityId: service.config.communityId,
      communityOrigin: service.config.app.origin,
      connectionId: row.connection_id,
      requestId: row.request_id,
      accountRef,
      state,
    },
    verifyReceipt = service.verifyReceipt ?? verifyCreatorReceipt;
  let receipt: Awaited<ReturnType<typeof verifyCreatorReceipt>>;
  try {
    receipt = await verifyReceipt(result.receipt, expected);
  } catch (error) {
    if (
      !(error instanceof CommunityError) ||
      error.code !== "creator_receipt_expired"
    )
      throw error;
    const expired = await verifyReceipt(
      result.receipt,
      expected,
      Date.now(),
      undefined,
      true,
    );
    await db
      .prepare(
        "UPDATE creator_connections SET expired_receipt_json=?,consumed=1,verifier_secret=NULL WHERE connection_id=? AND account_id=? AND session_hash=? AND consumed=0 AND receipt_json IS NULL",
      )
      .bind(canonical(expired), id, session.account_id, session.session_hash)
      .run();
    const saved = await ownedConnection(db, id, session);
    if (saved.receipt_json)
      return {
        state: "connected",
        creator: object(JSON.parse(saved.receipt_json)).payload,
      };
    insist(
      saved.expired_receipt_json === canonical(expired),
      "creator_connection_recovery_conflict",
      409,
    );
    return { state: "verification_expired", requiresReconnect: true };
  }
  return retainCreatorBinding(db, session, id, receipt);
}
/** Caller supplies a cryptographically verified, scope-bound native receipt. */
export async function retainCreatorBinding(
  db: D1Database,
  session: AccountSession,
  id: string,
  receipt: Awaited<ReturnType<typeof verifyCreatorReceipt>>,
) {
  insist(
    receipt.payload.verifiedAt > Date.now() - 300_000 &&
      receipt.payload.expiresAt > Date.now(),
    "creator_receipt_expired",
    409,
  );
  const connection = await ownedConnection(db, id, session),
    application = await db
      .prepare(
        "SELECT community_id,community_origin FROM application_identity WHERE id=1",
      )
      .first<{ community_id: string; community_origin: string }>();
  insist(
    application &&
      receipt.payload.communityId === application.community_id &&
      receipt.payload.communityOrigin === application.community_origin &&
      receipt.payload.connectionId === id &&
      receipt.payload.requestId === connection.request_id &&
      hashText(receipt.payload.state) === connection.state_hash &&
      receipt.payload.accountRef ===
        hashJson({
          schema: "pirate.creator-account/1",
          communityId: application.community_id,
          accountId: session.account_id,
        }),
    "creator_receipt_scope_mismatch",
    403,
  );
  const p = receipt.payload,
    encoded = canonical(receipt),
    guard = token();
  await db.batch([
    db
      .prepare(
        `INSERT INTO creator_bindings(account_id,service_origin,credential_ref,sui_address,dwallet_id,capability_id,share_id,evm_address,receipt_json,verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET receipt_json=excluded.receipt_json,verified_at=excluded.verified_at
      WHERE creator_bindings.service_origin=excluded.service_origin AND creator_bindings.credential_ref=excluded.credential_ref AND
      creator_bindings.sui_address=excluded.sui_address AND creator_bindings.dwallet_id=excluded.dwallet_id AND
      creator_bindings.capability_id=excluded.capability_id AND creator_bindings.share_id=excluded.share_id AND creator_bindings.evm_address=excluded.evm_address`,
      )
      .bind(
        session.account_id,
        p.serviceOrigin,
        p.credentialRef,
        p.suiAddress,
        p.dWalletId,
        p.capabilityId,
        p.shareId,
        p.evmAddress,
        encoded,
        p.verifiedAt,
      ),
    db
      .prepare(
        "INSERT INTO transaction_guards(guard_id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM creator_bindings WHERE account_id=? AND receipt_json=?) THEN 1 ELSE 0 END",
      )
      .bind(guard, session.account_id, encoded),
    db
      .prepare(
        "UPDATE creator_connections SET receipt_json=?,consumed=1,verifier_secret=NULL WHERE connection_id=? AND account_id=? AND session_hash=? AND ((consumed=0 AND receipt_json IS NULL AND expired_receipt_json IS NULL) OR receipt_json=?)",
      )
      .bind(encoded, id, session.account_id, session.session_hash, encoded),
    db
      .prepare(
        "UPDATE transaction_guards SET valid=CASE WHEN EXISTS(SELECT 1 FROM creator_connections WHERE connection_id=? AND account_id=? AND session_hash=? AND consumed=1 AND receipt_json=?) THEN 1 ELSE 0 END WHERE guard_id=?",
      )
      .bind(id, session.account_id, session.session_hash, encoded, guard),
    db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(guard),
  ]);
  const saved = await ownedConnection(db, id, session);
  insist(saved.receipt_json === encoded, "creator_binding_conflict", 409);
  return { state: "connected", creator: p };
}
export async function pendingCreatorConnection(
  db: D1Database,
  session: AccountSession,
) {
  const row = await db
    .prepare(
      "SELECT connection_id,state_secret,request_id,expires_at FROM creator_connections WHERE account_id=? AND session_hash=? AND consumed=0 AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(session.account_id, session.session_hash, Date.now())
    .first<Connection>();
  return row
    ? {
        connectionId: row.connection_id,
        state: row.state_secret,
        requestId: row.request_id,
        expiresAt: row.expires_at,
      }
    : null;
}
