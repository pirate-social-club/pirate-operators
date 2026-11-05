import { Transaction } from "@mysten/sui/transactions";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import {
  CoordinatorInnerModule as C,
  coordinatorTransactions as ct,
} from "@ika.xyz/sdk";
import {
  b64,
  unb64,
  hash,
  randomToken,
  walletOrigin,
  utf8,
} from "../shared.ts";
import {
  bytes,
  credential,
  insist,
  link,
  record,
  session,
  str,
  type CredentialRow,
  type Env,
} from "./store.ts";
import {
  clients,
  config,
  coordinator,
  event,
  feeBudget,
  fees,
  gasBudget,
  operatorAddress,
  refund,
  submit,
  verifyWallet,
} from "./chain.ts";
import { evmKey } from "./evm-key.ts";
import { verifyPasskeyProof } from "./passkey-proof.ts";
import { requireActivationRecovery } from "./activation-recovery.ts";
import { finishScopedConnection } from "./community-connection.ts";

export interface AttemptRow {
  id: string;
  account: string;
  credential_id: string;
  status: string;
  intent: string;
  dwallet_id: string | null;
  cap_id: string | null;
  share_id: string | null;
  dkg_digest: string | null;
  acceptance_digest: string | null;
}
export async function context(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const s = await session(request, env, "creator");
  const l = await link(env, str(body, "request", 100));
  insist(l.credential_id === s.account, "wrong_creator_session", 403);
  return { row: await credential(env, s.account), connection: l };
}
export async function currentAttempt(env: Env, row: CredentialRow) {
  const a = await env.DB.prepare(
    "SELECT * FROM attempts WHERE credential_id=? AND status<>'failed'",
  )
    .bind(row.id)
    .first<AttemptRow>();
  insist(a, "activation_not_started", 409);
  return a;
}
export async function reserve(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row, connection } = await context(request, env, body);
  const existing = await env.DB.prepare(
    "SELECT * FROM attempts WHERE (account=? OR credential_id=?) AND status<>'failed'",
  )
    .bind(connection.account, row.id)
    .first<AttemptRow>();
  if (existing) {
    insist(
      existing.account === connection.account &&
        existing.credential_id === row.id,
      "creator_already_reserved",
      409,
    );
    return {
      attempt: existing,
      intent: JSON.parse(existing.intent),
      consentMessage: existing.intent,
    };
  }
  insist(row.status === "saved", "creator_already_active", 409);
  const { ika, sui } = clients();
  const balances = await Promise.all([
    sui.getBalance({ owner: operatorAddress }),
    sui.getBalance({
      owner: operatorAddress,
      coinType: `${config.packages.ikaPackage}::ika::IKA`,
    }),
  ]);
  insist(
    BigInt(balances[0]!.balance.balance) >= 600_000_000n &&
      BigInt(balances[1]!.balance.balance) >= 22_000_000_000n,
    "operator_needs_testnet_funding",
    503,
  );
  const networkKey = await ika.getLatestNetworkEncryptionKey();
  const intent = {
    purpose: "pirate-creator-activation/v1",
    origin: walletOrigin,
    account: connection.account,
    network: "testnet",
    operator: operatorAddress,
    creator: row.sui_address,
    networkKeyId: networkKey.id,
    session: randomToken(),
    encryptionKeyHash: await hash(bytes(body, "encryptionKey", 20_000)),
    signingKey: b64(bytes(body, "signingKey", 32)),
    curve: "secp256k1",
    kind: "zero-trust",
    packages: config.packages,
    maxIka: "22000000000",
    maxSui: "600000000",
    expires: Date.now() + 900_000,
  };
  const id = randomToken();
  await env.DB.prepare(
    "INSERT INTO attempts(id,account,credential_id,intent,created) VALUES(?,?,?,?,?)",
  )
    .bind(id, connection.account, row.id, JSON.stringify(intent), Date.now())
    .run();
  return {
    attempt: await currentAttempt(env, row),
    intent,
    consentMessage: JSON.stringify(intent),
  };
}
export async function dkg(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    a = await currentAttempt(env, row);
  if (a.dwallet_id) return { attempt: a };
  await requireActivationRecovery(env, a.id, row.id, body);
  const intent = JSON.parse(a.intent);
  const encryptionKey = bytes(body, "encryptionKey", 20_000),
    signingKey = bytes(body, "signingKey", 32),
    encryptionSignature = bytes(body, "encryptionSignature", 64);
  insist(
    signingKey.length === 32 && encryptionSignature.length === 64,
    "invalid_encryption_identity",
  );
  // Only a persisted, unsubmitted intent can spend new funds. Retries of a
  // persisted submission reconcile the same bytes even after consent expires.
  const submitted = await env.DB.prepare(
    "SELECT id FROM submissions WHERE id=?",
  )
    .bind(`${a.id}:dkg`)
    .first();
  if (!submitted) {
    insist(
      intent.expires > Date.now() &&
        intent.encryptionKeyHash === (await hash(encryptionKey)) &&
        intent.signingKey === b64(signingKey),
      "activation_consent_mismatch_or_expired",
      401,
    );
    await verifyPasskeyProof(
      row.sui_public_key,
      utf8.encode(a.intent),
      str(body, "consentSignature", 4096),
      "personal",
    );
  }
  const encAddress = new Ed25519PublicKey(signingKey).toSuiAddress();
  const receipt = await submit(env, a.id, "dkg", async () => {
    const tx = new Transaction();
    tx.setSender(operatorAddress);
    tx.setGasBudget(gasBudget);
    const coord = coordinator(tx),
      coins = fees(tx, feeBudget.dkg);
    ct.registerEncryptionKeyTx(
      config,
      coord,
      0,
      encryptionKey,
      encryptionSignature,
      signingKey,
      tx,
    );
    const sid = ct.registerSessionIdentifier(
      config,
      coord,
      unb64(intent.session),
      tx,
    );
    const [cap, optionalSign] = ct.requestDWalletDKG(
      config,
      coord,
      intent.networkKeyId,
      0,
      bytes(body, "message", 500_000),
      bytes(body, "encryptedShare", 500_000),
      encAddress,
      bytes(body, "publicOutput", 500_000),
      signingKey,
      sid,
      null,
      coins.ika,
      coins.sui,
      tx,
    );
    tx.moveCall({
      target: "0x1::option::destroy_none",
      typeArguments: ["0x2::object::ID"],
      arguments: [optionalSign!],
    });
    tx.transferObjects([cap!], row.sui_address);
    refund(tx, coins, operatorAddress);
    return { tx };
  });
  const created = event(
    receipt,
    "DWalletDKGRequestEvent",
    C.DWalletDKGRequestEvent,
  );
  insist(
    created.user_secret_key_share.$kind === "Encrypted" &&
      created.curve === 0 &&
      created.dwallet_network_encryption_key_id === intent.networkKeyId,
    "unexpected_dkg_result",
    503,
  );
  const shareId =
    created.user_secret_key_share.Encrypted.encrypted_user_secret_key_share_id;
  await verifyWallet(
    created.dwallet_id,
    created.dwallet_cap_id,
    shareId,
    row.sui_address,
    false,
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE attempts SET status='creating',dwallet_id=?,cap_id=?,share_id=?,dkg_digest=? WHERE id=?",
    ).bind(
      created.dwallet_id,
      created.dwallet_cap_id,
      shareId,
      receipt.digest,
      a.id,
    ),
    env.DB.prepare(
      "UPDATE credentials SET status='creating',dwallet_id=?,cap_id=?,share_id=? WHERE id=?",
    ).bind(created.dwallet_id, created.dwallet_cap_id, shareId, row.id),
  ]);
  return { attempt: await currentAttempt(env, row) };
}
export async function activate(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    a = await currentAttempt(env, row);
  insist(a.dwallet_id && a.cap_id && a.share_id, "dkg_not_submitted", 409);
  if (!a.acceptance_digest) {
    const receipt = await submit(env, a.id, "acceptance", async () => {
      const { dwallet, share } = await verifyWallet(
        a.dwallet_id!,
        a.cap_id!,
        a.share_id!,
        row.sui_address,
        false,
      );
      insist(
        dwallet.state.$kind === "AwaitingKeyHolderSignature" &&
          share.state.$kind === "NetworkVerificationCompleted",
        "dkg_not_ready",
        409,
      );
      const tx = new Transaction();
      tx.setSender(operatorAddress);
      tx.setGasBudget(gasBudget);
      ct.acceptEncryptedUserShare(
        config,
        coordinator(tx),
        a.dwallet_id!,
        a.share_id!,
        bytes(body, "signature", 64),
        tx,
      );
      return { tx };
    });
    await env.DB.prepare("UPDATE attempts SET acceptance_digest=? WHERE id=?")
      .bind(receipt.digest, a.id)
      .run();
  }
  return activationStatus(env, row, a);
}
export async function activationStatus(
  env: Env,
  row: CredentialRow,
  a: AttemptRow,
) {
  insist(a.dwallet_id && a.cap_id && a.share_id, "dkg_not_submitted", 409);
  const { dwallet, share } = await verifyWallet(
    a.dwallet_id,
    a.cap_id,
    a.share_id,
    row.sui_address,
    false,
  );
  if (
    dwallet.state.$kind !== "Active" ||
    share.state.$kind !== "KeyHolderSigned"
  )
    return { status: dwallet.state.$kind, shareStatus: share.state.$kind };
  const key = evmKey(Uint8Array.from(dwallet.state.Active.public_output));
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE credentials SET status='active',evm_public_key=?,evm_address=?,activated_at=COALESCE(activated_at,?) WHERE id=?",
    ).bind(key.publicKey, key.address, Date.now(), row.id),
    env.DB.prepare("UPDATE attempts SET status='active' WHERE id=?").bind(a.id),
  ]);
  return { status: "active", wallet: record(await credential(env, row.id)) };
}
export async function finish(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row, connection } = await context(request, env, body);
  insist(
    row.status === "active" && row.dwallet_id && row.cap_id && row.share_id,
    "wallet_not_active",
    409,
  );
  await verifyWallet(row.dwallet_id, row.cap_id, row.share_id, row.sui_address);
  const scoped = await finishScopedConnection(env, connection);
  if (scoped) return scoped;
  const code = randomToken();
  await env.DB.prepare("UPDATE links SET code_hash=? WHERE id=? AND consumed=0")
    .bind(await hash(code), connection.id)
    .run();
  return { code, state: connection.state };
}
