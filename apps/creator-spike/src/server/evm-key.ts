// @ts-expect-error Cloudflare imports a compiled module; upstream declares raw exports.
import wasm from "../../node_modules/@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm";
import {
  initSync,
  public_key_from_dwallet_output,
} from "@ika.xyz/ika-wasm/web";
import { publicKeyToAddress } from "viem/accounts";
import { bytesToHex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";
let initialized = false;
export function evmKey(output: Uint8Array) {
  if (!initialized) {
    initSync({ module: wasm });
    initialized = true;
  }
  const key = Uint8Array.from(public_key_from_dwallet_output(0, output));
  const hex = bytesToHex(secp256k1.Point.fromBytes(key).toBytes(false));
  return { publicKey: hex, address: publicKeyToAddress(hex) };
}
