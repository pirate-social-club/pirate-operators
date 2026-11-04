import {
  b64,
  unb64,
  utf8,
  derivation,
  rpId,
  prfSalt,
  type SealedSeed,
} from "./shared.ts";

function context(credentialId: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(
    JSON.stringify({
      purpose: "pirate-creator-seed/1",
      rpId,
      credentialId,
      derivation,
    }),
  );
}
async function wrappingKey(
  prf: Uint8Array,
  credentialId: string,
): Promise<CryptoKey> {
  if (prf.length !== 32)
    throw new Error("A 32-byte passkey PRF output is required");
  const input = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(prf),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: prfSalt,
      info: context(credentialId),
    },
    input,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealSeed(
  seed: Uint8Array,
  prf: Uint8Array,
  credentialId: string,
): Promise<SealedSeed> {
  if (seed.length !== 32)
    throw new Error("A 32-byte encryption seed is required");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(prf, credentialId);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: context(credentialId),
      tagLength: 128,
    },
    key,
    new Uint8Array(seed),
  );
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "HKDF-SHA256",
    derivation,
    rpId,
    credentialId,
    salt: b64(prfSalt),
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
  };
}
export async function openSeed(
  record: SealedSeed,
  prf: Uint8Array,
  credentialId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    record.version !== 1 ||
    record.algorithm !== "AES-256-GCM" ||
    record.kdf !== "HKDF-SHA256" ||
    record.derivation !== derivation ||
    record.rpId !== rpId ||
    record.credentialId !== credentialId ||
    record.salt !== b64(prfSalt)
  ) {
    throw new Error(
      "Encrypted record does not belong to this passkey and wallet site",
    );
  }
  const nonce = unb64(record.nonce),
    ciphertext = unb64(record.ciphertext);
  if (nonce.length !== 12 || ciphertext.length !== 48)
    throw new Error("Invalid encrypted seed");
  const key = await wrappingKey(prf, credentialId);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: context(credentialId),
        tagLength: 128,
      },
      key,
      ciphertext,
    ),
  );
}
