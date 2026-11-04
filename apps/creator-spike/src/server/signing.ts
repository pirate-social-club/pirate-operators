import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import {
  coordinatorTransactions as ct,
  CoordinatorInnerModule as C,
  Curve,
  SignatureAlgorithm,
} from "@ika.xyz/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, keccak256, bytesToHex } from "viem";
import {
  b64,
  unb64,
  randomToken,
  utf8,
  hash,
  sameBytes,
  walletOrigin,
} from "../shared.ts";
import { context, currentAttempt } from "./activation.ts";
import {
  clients,
  config,
  coordinator,
  event,
  feeBudget,
  fees,
  gasBudget,
  ikaType,
  operatorAddress,
  refund,
  submit,
  verifyWallet,
} from "./chain.ts";
import { bytes, insist, str, type Env } from "./store.ts";
import { verifyPasskeyProof } from "./passkey-proof.ts";
import { fixedSignMessage } from "../sign-message.ts";
import { recordSignatureSubmission } from "./binding.ts";
import {
  beginSignaturePreparation,
  saveSignaturePreparation,
  claimSignaturePreparation,
  capturedSignaturePreparation,
  releaseUnsubmittedPreparation,
} from "./operator-lock.ts";

interface SignRow {
  id: string;
  credential_id: string;
  message: string;
  status: string;
  presign_id: string | null;
  presign_cap_id: string | null;
  ika_coin_id: string | null;
  sui_coin_id: string | null;
  transaction_bytes: string | null;
  transaction_digest: string | null;
  sign_id: string | null;
  result: string | null;
}
async function signing(env: Env, credentialId: string) {
  const s = await env.DB.prepare(
    "SELECT * FROM signatures WHERE credential_id=?",
  )
    .bind(credentialId)
    .first<SignRow>();
  insist(s, "sign_test_not_started", 409);
  return s;
}
export async function startSign(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    a = await currentAttempt(env, row);
  insist(
    row.status === "active" && row.dwallet_id && row.cap_id && row.share_id,
    "wallet_not_active",
    409,
  );
  insist(
    row.authenticated_at &&
      row.activated_at &&
      row.authenticated_at > row.activated_at &&
      row.authenticated_at > Date.now() - 900_000,
    "reopen_wallet_with_passkey_first",
    401,
  );
  const verified = await verifyWallet(
    row.dwallet_id,
    row.cap_id,
    row.share_id,
    row.sui_address,
  );
  const id = randomToken();
  // One fixed, non-transaction EIP-191 test message per creator. No arbitrary signing API.
  insist(row.evm_address, "wallet_record_incomplete", 409);
  const message = fixedSignMessage(id, row.evm_address);
  await env.DB.prepare(
    "INSERT INTO signatures(id,credential_id,message,status,created) VALUES(?,?,?,'reserved',?) ON CONFLICT(credential_id) DO NOTHING",
  )
    .bind(id, row.id, message, Date.now())
    .run();
  let s = await signing(env, row.id);
  if (!s.presign_id) {
    const receipt = await submit(env, a.id, "presign", async () => {
      const tx = new Transaction();
      tx.setSender(operatorAddress);
      tx.setGasBudget(gasBudget);
      const coord = coordinator(tx),
        coins = fees(tx, feeBudget.presign);
      const sid = ct.registerSessionIdentifier(config, coord, unb64(s.id), tx);
      const cap = ct.requestGlobalPresign(
        config,
        coord,
        verified.dwallet.dwallet_network_encryption_key_id,
        0,
        0,
        sid,
        coins.ika,
        coins.sui,
        tx,
      );
      const signIka = tx.add(
        coinWithBalance({ balance: feeBudget.sign, type: ikaType }),
      );
      const signSui = tx.splitCoins(tx.gas, [feeBudget.sui])[0]!;
      tx.transferObjects([cap, signIka, signSui], row.sui_address);
      refund(tx, coins, operatorAddress);
      return { tx };
    });
    const p = event(receipt, "PresignRequestEvent", C.PresignRequestEvent);
    const owned = receipt.objects.filter((o) => o.owner === row.sui_address);
    const cap = owned.find((o) =>
      o.type.endsWith("::coordinator_inner::UnverifiedPresignCap"),
    );
    const ic = owned.find(
      (o) =>
        o.type === `0x2::coin::Coin<${ikaType}>` ||
        o.type.endsWith(`::coin::Coin<${ikaType}>`),
    );
    const sc = owned.find(
      (o) =>
        o.type.endsWith("::coin::Coin<0x2::sui::SUI>") ||
        o.type.endsWith("0002::sui::SUI>"),
    );
    insist(
      cap &&
        ic &&
        sc &&
        p.dwallet_id === null &&
        p.curve === 0 &&
        p.signature_algorithm === 0 &&
        p.dwallet_network_encryption_key_id ===
          verified.dwallet.dwallet_network_encryption_key_id,
      "invalid_presign_receipt",
      503,
    );
    await env.DB.prepare(
      "UPDATE signatures SET status='presigning',presign_id=?,presign_cap_id=?,ika_coin_id=?,sui_coin_id=? WHERE id=?",
    )
      .bind(p.presign_id, cap.id, ic.id, sc.id, s.id)
      .run();
    s = await signing(env, row.id);
  }
  return {
    id: s.id,
    message: s.message,
    presignId: s.presign_id,
    presignCapId: s.presign_cap_id,
    ikaCoinId: s.ika_coin_id,
    suiCoinId: s.sui_coin_id,
    operator: operatorAddress,
    status: s.status,
  };
}
export async function prepareSign(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    s = await signing(env, row.id);
  const a = await currentAttempt(env, row),
    submissionId = `${a.id}:sign`;
  if (
    await env.DB.prepare("SELECT id FROM submissions WHERE id=?")
      .bind(submissionId)
      .first()
  ) {
    await executeSign(request, env, body);
    return { alreadySubmitted: true, message: s.message };
  }
  insist(
    row.dwallet_id &&
      row.cap_id &&
      row.share_id &&
      s.presign_id &&
      s.presign_cap_id &&
      s.ika_coin_id &&
      s.sui_coin_id,
    "presign_not_requested",
    409,
  );
  const { ika, sui } = clients();
  const p = await ika.getPresign(s.presign_id);
  insist(
    p.state.$kind === "Completed" &&
      p.dwallet_id === null &&
      p.cap_id === s.presign_cap_id &&
      p.curve === 0 &&
      p.signature_algorithm === 0,
    "presign_not_ready",
    409,
  );
  await verifyWallet(row.dwallet_id, row.cap_id, row.share_id, row.sui_address);
  const preparation = await beginSignaturePreparation(
    env.DB,
    s.id,
    submissionId,
  );
  try {
    const tx = new Transaction();
    tx.setSender(row.sui_address);
    tx.setGasOwner(operatorAddress);
    tx.setGasBudget(gasBudget);
    const coord = coordinator(tx),
      sid = ct.registerSessionIdentifier(
        config,
        coord,
        unb64(await hash(`sign:${s.id}`)),
        tx,
      );
    const cap = ct.verifyPresignCap(
      config,
      coord,
      tx.object(s.presign_cap_id),
      tx,
    );
    const approval = ct.approveMessage(
      config,
      coord,
      tx.object(row.cap_id),
      0,
      0,
      unb64(s.message),
      tx,
    );
    const coins = {
      ika: tx.object(s.ika_coin_id),
      sui: tx.object(s.sui_coin_id),
    };
    ct.requestSign(
      config,
      coord,
      cap,
      approval,
      bytes(body, "partialSignature", 500_000),
      sid,
      coins.ika,
      coins.sui,
      tx,
    );
    refund(tx, coins, row.sui_address);
    const raw = await tx.build({ client: sui });
    await saveSignaturePreparation(env.DB, s.id, preparation.token, b64(raw));
    return { bytes: b64(raw), message: s.message };
  } catch (error) {
    await releaseUnsubmittedPreparation(env.DB, s.id, preparation.token);
    throw error;
  }
}
export async function executeSign(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    a = await currentAttempt(env, row),
    s = await signing(env, row.id);
  insist(s.transaction_bytes, "sign_transaction_not_prepared", 409);
  const submitted = await env.DB.prepare(
    "SELECT id FROM submissions WHERE id=?",
  )
    .bind(`${a.id}:sign`)
    .first();
  const captured = submitted
    ? null
    : await capturedSignaturePreparation(env.DB, s.id);
  const signature = submitted
    ? ""
    : (captured?.user_signature ?? str(body, "signature", 4096));
  if (!submitted) {
    await verifyPasskeyProof(
      row.sui_public_key,
      unb64(s.transaction_bytes),
      signature,
      "transaction",
    );
    if (!captured)
      await claimSignaturePreparation(
        env.DB,
        s.id,
        s.transaction_bytes,
        signature,
      );
  }
  const receipt = await submit(env, a.id, "sign", async () => ({
    tx: Transaction.from(unb64(s.transaction_bytes!)),
    userSignature: signature,
  }));
  const e = event(receipt, "SignRequestEvent", C.SignRequestEvent);
  insist(
    e.dwallet_id === row.dwallet_id &&
      sameBytes(Uint8Array.from(e.message), unb64(s.message)),
    "sign_intent_mismatch",
    503,
  );
  await recordSignatureSubmission(env.DB, s.id, receipt.digest, e.sign_id);
  return { signId: e.sign_id, digest: receipt.digest };
}
export async function signStatus(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const { row } = await context(request, env, body),
    s = await signing(env, row.id);
  if (s.result) {
    await env.DB.prepare(
      "UPDATE signatures SET status='verified' WHERE id=? AND result IS NOT NULL",
    )
      .bind(s.id)
      .run();
    return JSON.parse(s.result);
  }
  if (!s.sign_id) return { status: s.status };
  const { ika } = clients();
  const sign = await ika.getSign(
    s.sign_id,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
  );
  if (sign.state.$kind !== "Completed") return { status: sign.state.$kind };
  insist(
    sign.dwallet_id === row.dwallet_id && row.evm_public_key,
    "wrong_signature_wallet",
    503,
  );
  const signature = Uint8Array.from(sign.state.Completed.signature);
  const digest = hexToBytes(keccak256(unb64(s.message)));
  insist(
    secp256k1.verify(
      signature.slice(0, 64),
      digest,
      hexToBytes(row.evm_public_key as `0x${string}`),
      { prehash: false, lowS: false },
    ),
    "invalid_evm_signature",
    503,
  );
  const result = {
    status: "verified",
    address: row.evm_address,
    signature: bytesToHex(signature),
    message: s.message,
    transactionDigest: s.transaction_digest,
    signId: s.sign_id,
  };
  await env.DB.prepare(
    "UPDATE signatures SET status='verified',result=? WHERE id=?",
  )
    .bind(JSON.stringify(result), s.id)
    .run();
  return result;
}
