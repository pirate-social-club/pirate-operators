import {
  b64,
  unb64,
  utf8,
  rpId,
  walletOrigin,
  derivation,
  hash,
} from "./shared.ts";

export interface ActivationPayload {
  consentSignature: string;
  message: string;
  publicOutput: string;
  encryptedShare: string;
}
export interface SealedActivation {
  schema: "pirate.creator-activation-recovery/1";
  credentialId: string;
  attemptId: string;
  payloadHash: string;
  nonce: string;
  ciphertext: string;
}
const purpose = "pirate.creator-activation-recovery/1";
function context(record: Omit<SealedActivation, "nonce" | "ciphertext">) {
  return utf8.encode(
    JSON.stringify({
      schema: record.schema,
      credentialId: record.credentialId,
      attemptId: record.attemptId,
      payloadHash: record.payloadHash,
      rpId,
      walletOrigin,
      derivation,
    }),
  );
}
export async function activationWrappingKey(
  seed: Uint8Array,
  credentialId: string,
) {
  if (seed.length !== 32 || !credentialId)
    throw new Error("Invalid activation wrapping identity.");
  const input = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(seed),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8.encode(purpose),
      info: utf8.encode(
        JSON.stringify({ credentialId, rpId, walletOrigin, derivation }),
      ),
    },
    input,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function activationPayload(
  value: Record<string, unknown>,
): ActivationPayload {
  const fields = [
    "consentSignature",
    "message",
    "publicOutput",
    "encryptedShare",
  ] as const;
  for (const field of fields)
    if (
      typeof value[field] !== "string" ||
      !value[field] ||
      value[field].length > 670000
    )
      throw new Error("Invalid activation recovery payload.");
  return {
    consentSignature: value.consentSignature as string,
    message: value.message as string,
    publicOutput: value.publicOutput as string,
    encryptedShare: value.encryptedShare as string,
  };
}
export const activationPayloadHash = (payload: ActivationPayload) =>
  hash(JSON.stringify(activationPayload({ ...payload })));
export async function sealActivation(
  key: CryptoKey,
  credentialId: string,
  attemptId: string,
  payload: ActivationPayload,
): Promise<SealedActivation> {
  const clear = utf8.encode(JSON.stringify(activationPayload({ ...payload })));
  if (clear.length > 1000000)
    throw new Error("Activation recovery proof is too large.");
  const record = {
    schema: purpose,
    credentialId,
    attemptId,
    payloadHash: await activationPayloadHash(payload),
  } as const;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: context(record) },
      key,
      clear,
    );
    return { ...record, nonce: b64(nonce), ciphertext: b64(ciphertext) };
  } finally {
    clear.fill(0);
  }
}
export async function openActivation(
  key: CryptoKey,
  credentialId: string,
  attemptId: string,
  record: SealedActivation,
) {
  if (
    record.schema !== purpose ||
    record.credentialId !== credentialId ||
    record.attemptId !== attemptId ||
    unb64(record.nonce).length !== 12 ||
    record.ciphertext.length > 1400000
  )
    throw new Error(
      "Activation proof belongs to a different wallet or attempt.",
    );
  const { nonce, ciphertext, ...scope } = record;
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(nonce), additionalData: context(scope) },
      key,
      unb64(ciphertext),
    ),
  );
  try {
    const payload = activationPayload(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if ((await activationPayloadHash(payload)) !== record.payloadHash)
      throw new Error("Activation recovery digest mismatch.");
    return payload;
  } finally {
    bytes.fill(0);
  }
}
