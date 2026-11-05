import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { PasskeyKeypair } from "@mysten/sui/keypairs/passkey";
import { Transaction } from "@mysten/sui/transactions";
import { coordinatorTransactions as ct, getNetworkConfig } from "@ika.xyz/sdk";
import {
  b64,
  unb64,
  hash,
  utf8,
  rpId,
  walletOrigin,
  randomToken,
} from "../src/shared.ts";
import { verifyPasskeyProof } from "../src/server/passkey-proof.ts";
import {
  validateSignTransaction,
  type SignIntent,
} from "../src/sign-intent.ts";

test("native Sui consent binds message, origin, RP ID and user verification", async () => {
  const scalar = p256.utils.randomSecretKey(),
    point = p256.getPublicKey(scalar, false),
    publicKey = p256.getPublicKey(scalar, true);
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64(scalar),
      x: b64(point.slice(1, 33)),
      y: b64(point.slice(33)),
    },
  });
  let origin = walletOrigin,
    rp = rpId,
    flags = 5;
  const key = new PasskeyKeypair(publicKey, {
    async create() {
      throw Error("Existing test fixture");
    },
    async get(challenge) {
      const client = utf8.encode(
        JSON.stringify({
          type: "webauthn.get",
          origin,
          challenge: b64(challenge),
          crossOrigin: false,
        }),
      );
      const authenticator = new Uint8Array([
        ...unb64(await hash(rp)),
        flags,
        0,
        0,
        0,
        1,
      ]);
      const signature = sign(
        "sha256",
        new Uint8Array([...authenticator, ...unb64(await hash(client))]),
        privateKey,
      );
      return {
        id: "test",
        rawId: new ArrayBuffer(0),
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        toJSON: () => {
          throw Error("Unused fixture method");
        },
        response: {
          clientDataJSON: client.buffer,
          authenticatorData: authenticator.buffer,
          signature: Uint8Array.from(signature).buffer,
          userHandle: null,
        },
      };
    },
  });
  const consent = utf8.encode(
    "pirate-creator-activation/v1: account, owner, encryption key and bounded fees",
  );
  const proof = await key.signPersonalMessage(consent);
  await verifyPasskeyProof(
    b64(publicKey),
    consent,
    proof.signature,
    "personal",
  );
  await assert.rejects(() =>
    verifyPasskeyProof(
      b64(publicKey),
      utf8.encode("different creator"),
      proof.signature,
      "personal",
    ),
  );
  origin = "https://attacker.example";
  await assert.rejects(async () =>
    verifyPasskeyProof(
      b64(publicKey),
      consent,
      (await key.signPersonalMessage(consent)).signature,
      "personal",
    ),
  );
  origin = walletOrigin;
  rp = "attacker.example";
  await assert.rejects(async () =>
    verifyPasskeyProof(
      b64(publicKey),
      consent,
      (await key.signPersonalMessage(consent)).signature,
      "personal",
    ),
  );
  rp = rpId;
  flags = 1;
  await assert.rejects(async () =>
    verifyPasskeyProof(
      b64(publicKey),
      consent,
      (await key.signPersonalMessage(consent)).signature,
      "personal",
    ),
  );
});

test("browser rejects changed message, partial proof, owner, transfer and gas budget", async () => {
  const address = (digit: string) => `0x${digit.repeat(64)}`,
    config = getNetworkConfig("testnet");
  const intent: SignIntent = {
    creator: address("1"),
    operator: address("2"),
    capId: address("3"),
    presignCapId: address("4"),
    ikaCoinId: address("5"),
    suiCoinId: address("6"),
    id: randomToken(),
    message: b64(utf8.encode("fixed test message")),
    partialSignature: b64(utf8.encode("test partial proof")),
  };
  const tx = new Transaction();
  tx.setSender(intent.creator);
  tx.setGasOwner(intent.operator);
  tx.setGasBudget(100_000_000);
  tx.setGasPrice(1000);
  const digest = "11111111111111111111111111111111";
  tx.setGasPayment([{ objectId: address("7"), version: "1", digest }]);
  const obj = (objectId: string) =>
    tx.objectRef({ objectId, version: "1", digest });
  const coord = tx.sharedObjectRef({
    objectId: config.objects.ikaDWalletCoordinator.objectID,
    initialSharedVersion:
      config.objects.ikaDWalletCoordinator.initialSharedVersion,
    mutable: true,
  });
  const sid = ct.registerSessionIdentifier(
    config,
    coord,
    unb64(await hash(`sign:${intent.id}`)),
    tx,
  );
  const cap = ct.verifyPresignCap(config, coord, obj(intent.presignCapId), tx);
  const approval = ct.approveMessage(
    config,
    coord,
    obj(intent.capId),
    0,
    0,
    unb64(intent.message),
    tx,
  );
  const ika = obj(intent.ikaCoinId),
    sui = obj(intent.suiCoinId);
  ct.requestSign(
    config,
    coord,
    cap,
    approval,
    unb64(intent.partialSignature),
    sid,
    ika,
    sui,
    tx,
  );
  tx.transferObjects([ika, sui], intent.creator);
  const bytes = await tx.build();
  await validateSignTransaction(bytes, intent);
  await assert.rejects(() =>
    validateSignTransaction(bytes, {
      ...intent,
      message: b64(utf8.encode("different message")),
    }),
  );
  await assert.rejects(() =>
    validateSignTransaction(bytes, {
      ...intent,
      partialSignature: b64(utf8.encode("different proof")),
    }),
  );
  await assert.rejects(() =>
    validateSignTransaction(bytes, { ...intent, creator: address("8") }),
  );
  const expensive = Transaction.from(bytes);
  expensive.setGasBudget(100_000_001);
  await assert.rejects(async () =>
    validateSignTransaction(await expensive.build(), intent),
  );
  const extra = Transaction.from(bytes);
  extra.transferObjects([extra.object(intent.capId)], intent.operator);
  await assert.rejects(async () =>
    validateSignTransaction(await extra.build(), intent),
  );
});
