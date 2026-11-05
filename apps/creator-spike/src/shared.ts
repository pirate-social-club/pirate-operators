export const communityOrigin =
  "https://pirate-creator-spike.piratesocialclub.workers.dev";
export const walletOrigin =
  "https://pirate-wallet-test.piratesocialclub.workers.dev";
export const rpId = new URL(walletOrigin).hostname;
export const suiUrl = "https://fullnode.testnet.sui.io:443";
export const megaUrl = "https://carrot.megaeth.com/rpc";
export const derivation =
  "ika-sdk-0.5.0/fromRootSeedKey/secp256k1/fixed-hash/wasm32";
export const prfSalt = new TextEncoder().encode(
  "pirate-creator-testnet/prf-wrap/v1",
);
export const utf8 = new TextEncoder();
export function b64(bytes: Uint8Array | ArrayBuffer): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const value of a) text += String.fromCharCode(value);
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function unb64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hash(value: string | Uint8Array): Promise<string> {
  return b64(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string" ? utf8.encode(value) : new Uint8Array(value),
    ),
  );
}
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
export interface SealedSeed {
  version: 1;
  algorithm: "AES-256-GCM";
  kdf: "HKDF-SHA256";
  derivation: typeof derivation;
  rpId: string;
  credentialId: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}
export interface WalletRecord {
  credentialId: string;
  suiPublicKey: string;
  suiAddress: string;
  sealedSeed: SealedSeed;
  dWalletId?: string;
  capId?: string;
  shareId?: string;
  evmPublicKey?: string;
  evmAddress?: string;
  status: "saved" | "creating" | "active";
}
export interface Attempt {
  id: string;
  account: string;
  credentialId: string;
  status: string;
  intent: string;
  created: number;
  dWalletId?: string;
  capId?: string;
  shareId?: string;
  dkgDigest?: string;
  acceptanceDigest?: string;
  error?: string;
}
export interface PublicConfig {
  communityOrigin: string;
  walletOrigin: string;
  rpId: string;
  operatorAddress: string;
  testnet: true;
  ready: boolean;
  reason?: string;
}
