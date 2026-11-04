import { PasskeyPublicKey } from "@mysten/sui/keypairs/passkey";
import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { hash, rpId, sameBytes, unb64, walletOrigin } from "../shared.ts";
import { insist } from "./store.ts";
export async function verifyPasskeyProof(
  publicKey: string,
  message: Uint8Array,
  signature: string,
  scope: "personal" | "transaction",
) {
  const parsed = parseSerializedSignature(signature);
  insist(parsed.signatureScheme === "Passkey", "native_passkey_required");
  const data = JSON.parse(parsed.clientDataJson);
  insist(
    data.origin === walletOrigin &&
      data.crossOrigin !== true &&
      parsed.authenticatorData.length >= 37 &&
      (parsed.authenticatorData[32]! & 5) === 5 &&
      sameBytes(parsed.authenticatorData.slice(0, 32), unb64(await hash(rpId))),
    "invalid_passkey_context",
    401,
  );
  const key = new PasskeyPublicKey(unb64(publicKey));
  insist(
    await (scope === "personal"
      ? key.verifyPersonalMessage(message, signature)
      : key.verifyTransaction(message, signature)),
    "invalid_passkey_signature",
    401,
  );
}
