import { megaethReadClient } from "../../../../packages/community/chain.ts";
import {
  authorizeCreatorRequest,
  creatorConnectionBody,
} from "../../../../packages/community/creator-service.ts";
import { readConfiguration } from "../../../../packages/community/directory-reader.ts";
import {
  CommunityError,
  canonical,
  exact,
  hashJson,
  object,
} from "../../../../packages/community/common.ts";
import { walletOrigin, hash, utf8 } from "../shared.ts";
import {
  HttpError,
  insist,
  credential,
  type Env,
  type LinkRow,
} from "./store.ts";
import { operator, verifyWallet } from "./chain.ts";
import { bindActiveCredential } from "./binding.ts";

// Curated disposable profile. A caller cannot introduce a registry, origin or RPC.
const profile = {
  chainId: 6343 as const,
  communityId:
    "0xd3f69af98a60cbebb54e77b4306115cfcd8f33d122da9d02e782972a6debea0f" as const,
  registry: "0x7a385a404d98ce83747650f7ca254004b8d59609" as const,
  directory: "0x7d67b9d276aa8c91a3579900a44bbb3096752e8a" as const,
  directoryCodeHash:
    "0x81d8a47bcdfebe9b7e1f459c94344467032902f573eaf42cc3fe8fb8434d54a0" as const,
  deploymentBlock: 34118363n,
};
interface ScopedConnection {
  request_id: string;
  community_id: string;
  account_ref: string;
  connection_id: string;
  identity_json: string;
  ready_at: number | null;
  receipt_json: string | null;
}
async function scoped(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT * FROM scoped_creator_connections WHERE request_id=?",
  )
    .bind(id)
    .first<ScopedConnection>();
}

export async function communityConnection(
  env: Env,
  action: "creator_launch" | "creator_exchange",
  input: unknown,
  currentConfiguration: Parameters<typeof authorizeCreatorRequest>[3] = async (
    communityId,
  ) => {
    insist(communityId === profile.communityId, "community_not_paired", 403);
    return readConfiguration(megaethReadClient(), profile);
  },
) {
  try {
    const verified = await authorizeCreatorRequest(
      input,
      action,
      walletOrigin,
      currentConfiguration,
    );
    const { authorization: a, body, wireHash } = verified;
    await env.DB.prepare(
      "INSERT INTO creator_request_nonces(community_id,nonce,wire_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    )
      .bind(a.communityId, a.nonce, wireHash, a.expiresAt)
      .run();
    const nonce = await env.DB.prepare(
      "SELECT wire_hash FROM creator_request_nonces WHERE community_id=? AND nonce=?",
    )
      .bind(a.communityId, a.nonce)
      .first<{ wire_hash: string }>();
    insist(nonce?.wire_hash === wireHash, "creator_request_nonce_reused", 409);
    if (action === "creator_launch") {
      const b = creatorConnectionBody(body),
        id = hashJson({
          communityId: a.communityId,
          connectionId: b.connectionId,
        }).slice(2),
        account = `community:${a.communityId}:${b.accountRef}`,
        identity = canonical({
          ...b,
          communityId: a.communityId,
          communityOrigin: a.communityOrigin,
          serviceOrigin: walletOrigin,
        }),
        expires = Date.now() + 86400_000;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO links(id,session_hash,account,origin,state,verifier_hash,expires) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        ).bind(
          id,
          `scoped:${b.accountRef}`,
          account,
          a.communityOrigin,
          b.state,
          b.verifierHash,
          expires,
        ),
        env.DB.prepare(
          "INSERT INTO scoped_creator_connections(request_id,community_id,account_ref,connection_id,identity_json) VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING",
        ).bind(id, a.communityId, b.accountRef, b.connectionId, identity),
      ]);
      const saved = await scoped(env, id),
        l = await env.DB.prepare("SELECT * FROM links WHERE id=?")
          .bind(id)
          .first<LinkRow>();
      insist(
        saved?.identity_json === identity && l && l.expires > Date.now(),
        "creator_connection_changed_or_expired",
        409,
      );
      return {
        requestId: id,
        url: `${walletOrigin}/wallet?request=${id}`,
        expiresAt: l.expires,
      };
    }
    exact(body, [
      "requestId",
      "connectionId",
      "accountRef",
      "state",
      "verifier",
    ]);
    insist(
      typeof body.requestId === "string" &&
        /^[a-f0-9]{64}$/.test(body.requestId) &&
        typeof body.verifier === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(body.verifier),
      "invalid_creator_exchange",
    );
    const saved = await scoped(env, body.requestId),
      l = await env.DB.prepare("SELECT * FROM links WHERE id=?")
        .bind(body.requestId)
        .first<LinkRow>();
    insist(saved && l, "creator_connection_not_found", 404);
    const identity = object(JSON.parse(saved.identity_json));
    insist(
      saved.community_id === a.communityId &&
        saved.account_ref === body.accountRef &&
        saved.connection_id === body.connectionId &&
        identity.communityOrigin === a.communityOrigin &&
        identity.serviceOrigin === walletOrigin &&
        l.origin === a.communityOrigin &&
        l.state === body.state &&
        l.verifier_hash === (await hash(body.verifier)),
      "creator_exchange_scope_mismatch",
      403,
    );
    // A lost response returns the exact first signed receipt, without another
    // chain action, identity change or freshness extension.
    if (saved.receipt_json)
      return { state: "connected", receipt: JSON.parse(saved.receipt_json) };
    insist(
      l.expires > Date.now() && !l.consumed,
      "creator_connection_expired",
      401,
    );
    if (!saved.ready_at) return { state: "waiting" };
    insist(l.credential_id, "creator_connection_not_approved", 409);
    const row = await credential(env, l.credential_id);
    insist(
      row.status === "active" &&
        row.dwallet_id &&
        row.cap_id &&
        row.share_id &&
        row.evm_address &&
        row.evm_public_key,
      "creator_not_active",
      409,
    );
    const proof = await verifyWallet(
      row.dwallet_id,
      row.cap_id,
      row.share_id,
      row.sui_address,
    );
    // The address is checked against the current native public output, never
    // accepted from a browser or from a stale database address alone.
    const { evmKey } = await import("./evm-key.ts");
    insist(proof.dwallet.state.$kind === "Active", "creator_not_active", 409);
    const evm = evmKey(
      Uint8Array.from(proof.dwallet.state.Active.public_output),
    );
    insist(
      evm.address.toLowerCase() === row.evm_address.toLowerCase(),
      "creator_address_changed",
      409,
    );
    const now = Date.now(),
      payload = {
        schema: "pirate.creator-binding/1",
        network: "sui-ika-testnet",
        serviceOrigin: walletOrigin,
        communityId: a.communityId,
        communityOrigin: a.communityOrigin,
        connectionId: saved.connection_id,
        requestId: saved.request_id,
        accountRef: saved.account_ref,
        state: l.state,
        credentialRef: hashJson({
          serviceOrigin: walletOrigin,
          credentialId: row.id,
        }),
        suiAddress: row.sui_address,
        dWalletId: row.dwallet_id,
        capabilityId: row.cap_id,
        shareId: row.share_id,
        evmAddress: row.evm_address.toLowerCase(),
        operatorFunded: true,
        verifiedAt: now,
        expiresAt: now + 300_000,
      };
    const signed = await operator(env).signPersonalMessage(
        utf8.encode(canonical(payload)),
      ),
      receipt = canonical({ payload, signature: signed.signature });
    await bindActiveCredential(env.DB, l.account, row.id);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE scoped_creator_connections SET receipt_json=? WHERE request_id=? AND receipt_json IS NULL AND ready_at IS NOT NULL",
      ).bind(receipt, saved.request_id),
      env.DB.prepare(
        "UPDATE links SET consumed=1 WHERE id=? AND EXISTS(SELECT 1 FROM scoped_creator_connections WHERE request_id=? AND receipt_json IS NOT NULL)",
      ).bind(l.id, l.id),
    ]);
    const final = await scoped(env, l.id);
    insist(final?.receipt_json, "creator_receipt_not_retained", 503);
    return { state: "connected", receipt: JSON.parse(final.receipt_json) };
  } catch (error) {
    if (error instanceof CommunityError)
      throw new HttpError(error.status, error.code);
    throw error;
  }
}
export async function scopedConnectionInfo(env: Env, id: string) {
  const row = await scoped(env, id);
  if (!row) return null;
  const identity = object(JSON.parse(row.identity_json));
  return {
    scoped: true,
    communityOrigin: identity.communityOrigin,
    connectionId: row.connection_id,
    purpose:
      "Connect this creator wallet to release a song. This does not authorize transfers or signing.",
    serviceOrigin: walletOrigin,
  };
}
export async function finishScopedConnection(env: Env, connection: LinkRow) {
  const row = await scoped(env, connection.id);
  if (!row) return null;
  await env.DB.prepare(
    "UPDATE scoped_creator_connections SET ready_at=COALESCE(ready_at,?) WHERE request_id=? AND receipt_json IS NULL",
  )
    .bind(Date.now(), connection.id)
    .run();
  return {
    scoped: true,
    requestId: connection.id,
    state: connection.state,
    origin: connection.origin,
    returnUrl: `${connection.origin}/creator/complete?connection=${row.connection_id}&state=${encodeURIComponent(connection.state)}`,
  };
}
