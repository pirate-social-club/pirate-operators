import { PasskeyKeypair } from "@mysten/sui/keypairs/passkey";
import {
  b64,
  unb64,
  prfSalt,
  rpId,
  randomToken,
  type WalletRecord,
} from "../shared.ts";
import { openSeed, sealSeed } from "../vault.ts";
import { api } from "./api.ts";

type PRFResults = AuthenticationExtensionsClientOutputs & {
  prf?: { enabled?: boolean; results?: { first: ArrayBuffer } };
};
function prf(credential: PublicKeyCredential) {
  const first = (credential.getClientExtensionResults() as PRFResults).prf
    ?.results?.first;
  if (!first || first.byteLength !== 32)
    throw new Error(
      "This passkey cannot unlock encrypted wallets. Use a browser and passkey provider with WebAuthn PRF support. No wallet transaction was sent.",
    );
  return new Uint8Array(first);
}
function extensions() {
  return {
    prf: { eval: { first: prfSalt } },
  } as AuthenticationExtensionsClientInputs;
}
function json(cred: PublicKeyCredential) {
  const r = cred.response;
  const common = {
    id: cred.id,
    rawId: b64(cred.rawId),
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
  if (r instanceof AuthenticatorAttestationResponse)
    return {
      ...common,
      response: {
        clientDataJSON: b64(r.clientDataJSON),
        attestationObject: b64(r.attestationObject),
        transports: r.getTransports(),
      },
    };
  const a = r as AuthenticatorAssertionResponse;
  return {
    ...common,
    response: {
      clientDataJSON: b64(a.clientDataJSON),
      authenticatorData: b64(a.authenticatorData),
      signature: b64(a.signature),
      userHandle: a.userHandle ? b64(a.userHandle) : undefined,
    },
  };
}
async function get(
  challenge: Uint8Array,
  credentialId?: string,
  withPRF = true,
) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(challenge),
      rpId,
      userVerification: "required",
      timeout: 120_000,
      allowCredentials: credentialId
        ? [{ type: "public-key", id: unb64(credentialId) }]
        : undefined,
      extensions: withPRF ? extensions() : undefined,
    },
  })) as PublicKeyCredential | null;
  if (!cred || (credentialId && cred.id !== credentialId))
    throw new Error(
      "Passkey selection was cancelled or did not match this wallet.",
    );
  return cred;
}
export async function unlock(
  request: string,
  register: boolean,
): Promise<{ wallet: WalletRecord; seed: Uint8Array }> {
  if (!window.isSecureContext || !navigator.credentials)
    throw new Error("Open this page in a browser that supports passkeys.");
  const o = await api<{ id: string; nonce: string; userId: string }>(
    "passkey/options",
    { request, mode: register ? "register" : "authenticate" },
  );
  if (!register) {
    const cred = await get(unb64(o.nonce));
    const output = prf(cred);
    try {
      const { wallet } = await api<{ wallet: WalletRecord }>(
        "passkey/authenticate",
        { id: o.id, response: json(cred) },
      );
      return {
        wallet,
        seed: await openSeed(wallet.sealedSeed, output, cred.id),
      };
    } finally {
      output.fill(0);
    }
  }
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: unb64(o.nonce),
      rp: { id: rpId, name: "Pirate creator test" },
      user: {
        id: unb64(o.userId),
        name: `creator-${o.userId.slice(0, 8)}`,
        displayName: "Pirate test creator",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: 120_000,
      extensions: extensions(),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled.");
  // Some authenticators expose PRF only on an assertion after registration.
  let output: Uint8Array;
  try {
    output = prf(cred);
  } catch {
    output = prf(await get(unb64(randomToken()), cred.id));
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    const sealedSeed = await sealSeed(seed, output, cred.id);
    const { wallet } = await api<{ wallet: WalletRecord }>("passkey/register", {
      id: o.id,
      response: json(cred),
      sealedSeed,
    });
    const restored = await openSeed(wallet.sealedSeed, output, cred.id);
    seed.fill(0);
    return { wallet, seed: restored };
  } catch (error) {
    seed.fill(0);
    throw error;
  } finally {
    output.fill(0);
  }
}
export function signer(wallet: WalletRecord) {
  return new PasskeyKeypair(
    unb64(wallet.suiPublicKey),
    {
      async create() {
        throw new Error("An existing creator passkey is required.");
      },
      async get(challenge) {
        return (await get(
          challenge,
          wallet.credentialId,
          false,
        )) as PublicKeyCredential & {
          response: AuthenticatorAssertionResponse;
        };
      },
    },
    unb64(wallet.credentialId),
  );
}
