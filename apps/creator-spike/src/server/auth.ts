import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { createSiweMessage } from "viem/siwe";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { PasskeyPublicKey } from "@mysten/sui/keypairs/passkey";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  b64,
  unb64,
  randomToken,
  hash,
  communityOrigin,
  walletOrigin,
  rpId,
  megaUrl,
  derivation,
  prfSalt,
} from "../shared.ts";
import {
  bindCredentialToLink,
  challenge,
  consumeChallenge,
  credential,
  insist,
  link,
  newSession,
  record,
  session,
  str,
  type Env,
} from "./store.ts";
import { verifyWallet } from "./chain.ts";
import { bindActiveCredential } from "./binding.ts";

export async function mossChallenge(env: Env, body: Record<string, unknown>) {
  const address = str(body, "address");
  insist(isAddress(address), "invalid_address");
  const nonce = randomToken().replaceAll("-", "a").replaceAll("_", "b");
  const message = createSiweMessage({
    address: address as Address,
    chainId: 6343,
    domain: new URL(communityOrigin).host,
    uri: communityOrigin,
    version: "1",
    nonce,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 300_000),
    statement:
      "Sign in to the Pirate creator test. This does not create a creator wallet or authorize spending.",
  });
  const id = await challenge(env, "moss", { address, message });
  return { id, message };
}
export async function mossVerify(env: Env, body: Record<string, unknown>) {
  const { address, message } = await consumeChallenge(
    env,
    str(body, "id"),
    "moss",
  );
  const signature = str(body, "signature", 32768);
  insist(/^0x[0-9a-f]+$/i.test(signature), "invalid_signature");
  const client = createPublicClient({
    transport: http(megaUrl, { timeout: 15_000, retryCount: 0 }),
  });
  insist((await client.getChainId()) === 6343, "wrong_moss_network", 503);
  const valid = await client.verifyMessage({
    address: address as Address,
    message: message as string,
    signature: signature as Hex,
  });
  insist(valid, "invalid_login_signature", 401);
  return {
    cookie: await newSession(
      env,
      "community",
      (address as string).toLowerCase(),
    ),
    address,
  };
}
export async function launch(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const s = await session(request, env, "community");
  const state = str(body, "state", 100),
    verifierHash = str(body, "verifierHash", 100);
  insist(
    /^[\w-]{43}$/.test(state) && /^[\w-]{43}$/.test(verifierHash),
    "invalid_connection",
  );
  const id = randomToken();
  await env.DB.prepare(
    "INSERT INTO links(id,session_hash,account,origin,state,verifier_hash,expires) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      s.hash,
      s.account,
      communityOrigin,
      state,
      verifierHash,
      Date.now() + 900_000,
    )
    .run();
  return { id, url: `${walletOrigin}/wallet?request=${id}` };
}
export async function passkeyOptions(env: Env, body: Record<string, unknown>) {
  const request = str(body, "request", 100),
    mode = str(body, "mode", 20);
  await link(env, request);
  insist(mode === "register" || mode === "authenticate", "invalid_mode");
  const nonce = randomToken(),
    userId = randomToken();
  const id = await challenge(env, mode, { request, nonce, userId });
  return { id, nonce, userId, rpId, mode };
}
export async function registerPasskey(env: Env, body: Record<string, unknown>) {
  const c = await consumeChallenge(env, str(body, "id"), "register");
  await link(env, c.request as string);
  const response = body.response as RegistrationResponseJSON;
  insist(response?.id && response.type === "public-key", "invalid_credential");
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: c.nonce as string,
    expectedOrigin: walletOrigin,
    expectedRPID: rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7],
  });
  insist(v.verified && v.registrationInfo, "invalid_passkey", 401);
  const cred = v.registrationInfo.credential;
  const cose = decodeCredentialPublicKey(cred.publicKey) as Map<
    number,
    unknown
  >;
  const x = cose.get(-2),
    y = cose.get(-3);
  insist(
    x instanceof Uint8Array &&
      x.length === 32 &&
      y instanceof Uint8Array &&
      y.length === 32,
    "invalid_passkey_curve",
  );
  const key = new Uint8Array(33);
  key[0] = 2 + (y[31]! & 1);
  key.set(x, 1);
  const suiAddress = new PasskeyPublicKey(key).toSuiAddress();
  const sealed = body.sealedSeed as Record<string, unknown>;
  insist(
    sealed &&
      sealed.version === 1 &&
      sealed.algorithm === "AES-256-GCM" &&
      sealed.kdf === "HKDF-SHA256" &&
      sealed.derivation === derivation &&
      sealed.rpId === rpId &&
      sealed.credentialId === cred.id &&
      sealed.salt === b64(prfSalt),
    "invalid_encrypted_record",
  );
  insist(
    typeof sealed.nonce === "string" &&
      unb64(sealed.nonce).length === 12 &&
      typeof sealed.ciphertext === "string" &&
      unb64(sealed.ciphertext).length === 48,
    "invalid_encrypted_record",
  );
  await env.DB.prepare(
    "INSERT INTO credentials(id,cose_key,counter,sui_public_key,sui_address,sealed_seed,created) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      cred.id,
      b64(cred.publicKey),
      cred.counter,
      b64(key),
      suiAddress,
      JSON.stringify(sealed),
      Date.now(),
    )
    .run();
  await bindCredentialToLink(env, c.request as string, cred.id);
  return {
    cookie: await newSession(env, "creator", cred.id),
    wallet: record(await credential(env, cred.id)),
  };
}
export async function authenticatePasskey(
  env: Env,
  body: Record<string, unknown>,
) {
  const c = await consumeChallenge(env, str(body, "id"), "authenticate");
  await link(env, c.request as string);
  const response = body.response as AuthenticationResponseJSON;
  insist(response?.id, "invalid_credential");
  const row = await credential(env, response.id);
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.nonce as string,
    expectedOrigin: walletOrigin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: row.id,
      publicKey: unb64(row.cose_key),
      counter: row.counter,
    },
  });
  insist(v.verified, "invalid_passkey", 401);
  const updated = await env.DB.prepare(
    "UPDATE credentials SET counter=?,authenticated_at=? WHERE id=? AND counter=?",
  )
    .bind(v.authenticationInfo.newCounter, Date.now(), row.id, row.counter)
    .run();
  insist(updated.meta.changes === 1, "passkey_authentication_raced_retry", 409);
  await bindCredentialToLink(env, c.request as string, row.id);
  return {
    cookie: await newSession(env, "creator", row.id),
    wallet: record(row),
  };
}
export async function exchange(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  const s = await session(request, env, "community");
  const codeHash = await hash(str(body, "code", 100));
  const verifierHash = await hash(str(body, "verifier", 100)),
    state = str(body, "state", 100);
  const l = await env.DB.prepare(
    "UPDATE links SET consumed=1 WHERE code_hash=? AND verifier_hash=? AND state=? AND session_hash=? AND account=? AND origin=? AND consumed=0 AND expires>? RETURNING credential_id",
  )
    .bind(
      codeHash,
      verifierHash,
      state,
      s.hash,
      s.account,
      communityOrigin,
      Date.now(),
    )
    .first<{ credential_id: string }>();
  insist(l, "invalid_or_replayed_connection", 401);
  const row = await credential(env, l.credential_id);
  insist(row.status === "active", "creator_not_active", 409);
  insist(
    row.dwallet_id && row.cap_id && row.share_id,
    "wallet_record_incomplete",
    409,
  );
  await verifyWallet(row.dwallet_id, row.cap_id, row.share_id, row.sui_address);
  await bindActiveCredential(env.DB, s.account, row.id);
  const sig = await env.DB.prepare(
    "SELECT status FROM signatures WHERE credential_id=?",
  )
    .bind(row.id)
    .first<{ status: string }>();
  return {
    suiAddress: row.sui_address,
    evmAddress: row.evm_address,
    dWalletId: row.dwallet_id,
    signed: sig?.status === "verified",
  };
}
