// Explicit live test with a software WebAuthn fixture. This does not establish
// real-device PRF support or MOSS SDK acceptance. Never run in default CI.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createPrivateKey, sign } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { Miniflare } from "miniflare";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { PasskeyKeypair } from "@mysten/sui/keypairs/passkey";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  IkaClient,
  getNetworkConfig,
  UserShareEncryptionKeys,
  prepareDKGAsync,
  Curve,
  Hash,
  SignatureAlgorithm,
  createUserSignMessageWithPublicOutput,
  type DKGRequestInput,
} from "@ika.xyz/sdk";
import {
  b64,
  unb64,
  hash,
  randomToken,
  utf8,
  rpId,
  walletOrigin,
  communityOrigin,
  type WalletRecord,
} from "../src/shared.ts";
import { sealSeed, openSeed } from "../src/vault.ts";
import { validateSignTransaction } from "../src/sign-intent.ts";

if (process.env.RUN_CREATOR_LIVE_SMOKE !== "1")
  throw new Error(
    "Set RUN_CREATOR_LIVE_SMOKE=1 for the bounded testnet smoke.",
  );
const secret = process.env.SMOKE_TEST_SEED;
if (!secret)
  throw new Error(
    "Inject SMOKE_TEST_SEED from the dedicated Infisical project.",
  );
process.umask(0o077);
const dir = resolve(
  homedir(),
  ".local/state/pirate-creator-wallet-testnet/smoke",
);
await mkdir(dir, { recursive: true, mode: 0o700 });
const scalar = unb64(secret),
  pub = p256.getPublicKey(scalar, false),
  compressed = p256.getPublicKey(scalar, true);
const privateKey = createPrivateKey({
  key: {
    kty: "EC",
    crv: "P-256",
    d: b64(scalar),
    x: b64(pub.slice(1, 33)),
    y: b64(pub.slice(33)),
  },
  format: "jwk",
});
const id = await hash(`credential:${secret}`),
  prf = unb64(await hash(`prf:${secret}`));
const sui = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io:443",
  }),
  ika = new IkaClient({ suiClient: sui, config: getNetworkConfig("testnet") });
const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: resolve("dist/worker/index.js") },
    { type: "CompiledWasm", path: resolve("dist/worker/ika.wasm") },
  ],
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "live-smoke" },
  d1Persist: `${dir}/d1`,
  bindings: {
    SUI_OPERATOR_SECRET_KEY: process.env.SUI_OPERATOR_SECRET_KEY!,
    LOCAL_TEST_DIAGNOSTICS: "true",
  },
  serviceBindings: { ASSETS: async () => new Response("smoke") },
});
const db = await mf.getD1Database("DB");
let cookie = "";
async function api<T = any>(
  path: string,
  body: unknown,
  origin = walletOrigin,
  sessionCookie = cookie,
): Promise<T> {
  const response = await mf.dispatchFetch(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "Content-Type": "application/json",
      cookie: sessionCookie,
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  if (response.headers.has("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return json;
}
async function assertion(challenge: string, counter: number) {
  const client = utf8.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: walletOrigin,
      crossOrigin: false,
    }),
  );
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, counter);
  const authenticator = new Uint8Array([
    ...unb64(await hash(rpId)),
    5,
    ...count,
  ]);
  const signature = sign(
    "sha256",
    new Uint8Array([...authenticator, ...unb64(await hash(client))]),
    privateKey,
  );
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64(client),
      authenticatorData: b64(authenticator),
      signature: b64(signature),
      userHandle: null,
    },
  };
}
function fixtureSigner(counter: number) {
  return new PasskeyKeypair(
    compressed,
    {
      async create() {
        throw Error("Existing fixture only");
      },
      async get(challenge) {
        const r = await assertion(b64(challenge), counter);
        return {
          id,
          rawId: unb64(id).buffer,
          type: "public-key",
          authenticatorAttachment: "platform",
          getClientExtensionResults: () => ({}),
          toJSON: () => {
            throw Error("Unused fixture method");
          },
          response: {
            clientDataJSON: unb64(r.response.clientDataJSON).buffer,
            authenticatorData: unb64(r.response.authenticatorData).buffer,
            signature: unb64(r.response.signature).buffer,
            userHandle: null,
          },
        };
      },
    },
    unb64(id),
  );
}
async function wait<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  label: string,
) {
  const until = Date.now() + 600_000;
  let last = 0;
  while (Date.now() < until) {
    const v = await read();
    if (ready(v)) return v;
    if (Date.now() - last > 15_000) {
      console.log(label);
      last = Date.now();
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timeout: ${label}`);
}
try {
  await db.exec((await readFile("schema.sql", "utf8")).replaceAll("\n", " "));
  const token = randomToken(),
    account = "software-passkey-live-smoke",
    state = randomToken(),
    verifier = randomToken();
  await db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(await hash(token), "community", account, Date.now() + 900_000)
    .run();
  const connection = await api<{ id: string }>(
    "launch",
    { state, verifierHash: await hash(verifier) },
    communityOrigin,
    `__Host-community_session=${token}`,
  );
  const request = connection.id;
  let wallet: WalletRecord;
  const exists = await db
    .prepare("SELECT id FROM credentials WHERE id=?")
    .bind(id)
    .first();
  if (!exists) {
    const options = await api("passkey/options", { request, mode: "register" });
    const cose = isoCBOR.encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, pub.slice(1, 33)],
        [-3, pub.slice(33)],
      ]) as never,
    );
    const data = utf8.encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.nonce,
        origin: walletOrigin,
        crossOrigin: false,
      }),
    );
    const auth = new Uint8Array([
      ...unb64(await hash(rpId)),
      0x45,
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      0,
      32,
      ...unb64(id),
      ...cose,
    ]);
    const attestation = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", auth],
      ]) as never,
    );
    const seed = unb64(await hash(`wallet:${secret}`)),
      sealedSeed = await sealSeed(seed, prf, id);
    seed.fill(0);
    ({ wallet } = await api("passkey/register", {
      id: options.id,
      sealedSeed,
      response: {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(data),
          attestationObject: b64(attestation),
          transports: ["internal"],
        },
      },
    }));
  } else {
    const counter =
      (await db
        .prepare("SELECT counter FROM credentials WHERE id=?")
        .bind(id)
        .first<{ counter: number }>())!.counter + 1;
    const options = await api("passkey/options", {
      request,
      mode: "authenticate",
    });
    ({ wallet } = await api("passkey/authenticate", {
      id: options.id,
      response: await assertion(options.nonce, counter),
    }));
  }
  const seed = await openSeed(wallet.sealedSeed, prf, id);
  let keys = await UserShareEncryptionKeys.fromRootSeedKey(
    seed,
    Curve.SECP256K1,
  );
  seed.fill(0);
  if (wallet.status !== "active") {
    const reserved = await api("activation/reserve", {
      request,
      encryptionKey: b64(keys.encryptionKey),
      signingKey: b64(keys.getSigningPublicKeyBytes()),
    });
    const intent = reserved.intent;
    const consent = await fixtureSigner(0).signPersonalMessage(
      utf8.encode(reserved.consentMessage),
    );
    const cryptKey = await crypto.subtle.importKey(
      "raw",
      prf,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    let prepared: DKGRequestInput;
    try {
      const saved = JSON.parse(await readFile(`${dir}/dkg.json`, "utf8"));
      const decoded = JSON.parse(
        new TextDecoder().decode(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: unb64(saved.iv) },
            cryptKey,
            unb64(saved.data),
          ),
        ),
      );
      assert.equal(saved.intent, intent.session);
      prepared = Object.fromEntries(
        Object.entries(decoded).map(([k, v]) => [k, unb64(v as string)]),
      ) as unknown as DKGRequestInput;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log("Preparing browser-equivalent DKG fixture");
      const pinned = new IkaClient({
        suiClient: sui,
        config: getNetworkConfig("testnet"),
        encryptionKeyOptions: { encryptionKeyID: intent.networkKeyId },
      });
      prepared = await prepareDKGAsync(
        pinned,
        Curve.SECP256K1,
        keys,
        unb64(intent.session),
        intent.operator,
      );
      const iv = crypto.getRandomValues(new Uint8Array(12)),
        data = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptKey,
          utf8.encode(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(prepared).map(([k, v]) => [k, b64(v)]),
              ),
            ),
          ),
        );
      await writeFile(
        `${dir}/dkg.json`,
        JSON.stringify({
          intent: intent.session,
          iv: b64(iv),
          data: b64(data),
        }),
        { mode: 0o600, flag: "wx" },
      );
    }
    const { attempt } = await api("activation/dkg", {
      request,
      consentSignature: consent.signature,
      encryptionKey: b64(keys.encryptionKey),
      signingKey: b64(keys.getSigningPublicKeyBytes()),
      encryptionSignature: b64(await keys.getEncryptionKeySignature()),
      message: b64(prepared.userDKGMessage),
      publicOutput: b64(prepared.userPublicOutput),
      encryptedShare: b64(prepared.encryptedUserShareAndProof),
    });
    console.log(
      JSON.stringify({
        dkgDigest: attempt.dkg_digest,
        dWalletId: attempt.dwallet_id,
        capId: attempt.cap_id,
      }),
    );
    const d = await wait(
      () => ika.getDWallet(attempt.dwallet_id),
      (v) =>
        v.state.$kind === "AwaitingKeyHolderSignature" ||
        v.state.$kind === "Active",
      "Waiting for Ika DKG",
    );
    if (d.state.$kind === "AwaitingKeyHolderSignature") {
      assert.equal(d.dwallet_network_encryption_key_id, intent.networkKeyId);
      const share = await ika.getEncryptedUserSecretKeyShare(attempt.share_id);
      assert.deepEqual(
        Uint8Array.from(share.encrypted_centralized_secret_share_and_proof),
        prepared.encryptedUserShareAndProof,
      );
      await api("activation/accept", {
        request,
        signature: b64(
          await keys.getUserOutputSignature(d, prepared.userPublicOutput),
        ),
      });
    }
    const active = await wait(
      () => api("activation/status", { request }),
      (v) => v.status === "active",
      "Waiting for Active",
    );
    wallet = active.wallet;
    prepared.userSecretKeyShare.fill(0);
  }
  console.log(
    JSON.stringify({
      active: wallet.dWalletId,
      address: wallet.evmAddress,
      creator: wallet.suiAddress,
    }),
  );
  keys.decryptionKey.fill(0);
  keys = undefined as unknown as UserShareEncryptionKeys;
  const options = await api("passkey/options", {
      request,
      mode: "authenticate",
    }),
    counter =
      (await db
        .prepare("SELECT counter FROM credentials WHERE id=?")
        .bind(id)
        .first<{ counter: number }>())!.counter + 1;
  ({ wallet } = await api("passkey/authenticate", {
    id: options.id,
    response: await assertion(options.nonce, counter),
  }));
  const reopened = await openSeed(wallet.sealedSeed, prf, id);
  keys = await UserShareEncryptionKeys.fromRootSeedKey(
    reopened,
    Curve.SECP256K1,
  );
  reopened.fill(0);
  const d = await ika.getDWallet(wallet.dWalletId!),
    share = await ika.getEncryptedUserSecretKeyShare(wallet.shareId!),
    pp = await ika.getProtocolPublicParameters(d, Curve.SECP256K1);
  const restored = await keys.decryptUserShare(d, share, pp);
  const saved = await db
    .prepare("SELECT result FROM signatures WHERE credential_id=?")
    .bind(id)
    .first<{ result: string }>();
  let result;
  if (saved?.result) result = JSON.parse(saved.result);
  else {
    const s = await api("sign/start", { request });
    const p = await wait(
      () => ika.getPresign(s.presignId),
      (v) => v.state.$kind === "Completed",
      "Waiting for presign",
    );
    assert(p.state.$kind === "Completed");
    const partial = await createUserSignMessageWithPublicOutput(
      pp,
      restored.verifiedPublicOutput,
      restored.secretShare,
      Uint8Array.from(p.state.Completed.presign),
      unb64(s.message),
      Hash.KECCAK256,
      SignatureAlgorithm.ECDSASecp256k1,
      Curve.SECP256K1,
    );
    const tx = await api("sign/prepare", {
      request,
      partialSignature: b64(partial),
    });
    if (!tx.alreadySubmitted) {
      await validateSignTransaction(unb64(tx.bytes), {
        ...s,
        creator: wallet.suiAddress,
        capId: wallet.capId!,
        partialSignature: b64(partial),
      });
      const signed = await fixtureSigner(counter + 1).signTransaction(
        unb64(tx.bytes),
      );
      await api("sign/execute", { request, signature: signed.signature });
    }
    result = await wait(
      () => api("sign/status", { request }),
      (v) => v.status === "verified",
      "Waiting for test signature",
    );
  }
  restored.secretShare.fill(0);
  keys.decryptionKey.fill(0);
  const finish = await api("finish", { request });
  const exchanged = await api(
    "exchange",
    { ...finish, verifier },
    communityOrigin,
    `__Host-community_session=${token}`,
  );
  assert(exchanged.signed);
  assert.equal(result.address, wallet.evmAddress);
  await writeFile(
    `${dir}/result.json`,
    JSON.stringify(
      {
        scope:
          "software-passkey Ika testnet; real browser PRF and MOSS not covered",
        ...result,
        dWalletId: wallet.dWalletId,
        capId: wallet.capId,
        creator: wallet.suiAddress,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      address: result.address,
      digest: result.transactionDigest,
    }),
  );
} finally {
  await mf.dispose();
}
