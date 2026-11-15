import { insist, hashText } from "./common.ts";
import { nativeCanonical } from "./native-business-binding.ts";
import type {SignedRecord} from "../../deploy/linux/installed-records.ts";
import type {CurrentAdmission} from "../../deploy/linux/full-profile-authority.ts";

export type NativeReadbackRole = "application" | "login" | "media" | "learning";
export interface NativeReadbackRequest {
  version: 1; role: NativeReadbackRole; nonce: string; issuedAt: number; expiresAt: number;
  installationId: string; profileDigest: string; generation: number; resourceId: string;
  method: "GET"; path: string; cookieHash: string;
  current:SignedRecord<CurrentAdmission>;
}
const bytes = (key: string) => {
  insist(/^[a-f0-9]{64}$/.test(key), "native_readback_key_required", 503);
  return Uint8Array.from(key.match(/../g)!, x => parseInt(x, 16));
};
export async function signNativeReadback(input: NativeReadbackRequest, key: string) {
  const secret = bytes(key);
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const payload = nativeCanonical(input);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload)));
    return { "X-Pirate-Native-Request": payload,
      "X-Pirate-Native-Mac": Array.from(mac, x => x.toString(16).padStart(2,"0")).join("") };
  } finally { secret.fill(0); }
}
export async function authenticateNativeReadback(request: Request, key: string, now = Date.now()) {
  const raw=request.headers.get("X-Pirate-Native-Request"), mac=request.headers.get("X-Pirate-Native-Mac");
  insist(raw && raw.length <= 8192 && mac && /^[a-f0-9]{64}$/.test(mac), "native_readback_authentication", 403);
  const value: NativeReadbackRequest=JSON.parse(raw);
  insist(nativeCanonical(value)===raw && value.version===1 &&
    ["application","login","media","learning"].includes(value.role) &&
    /^[a-f0-9]{64}$/.test(value.nonce) && !/^0+$/.test(value.nonce) &&
    Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt<=now && value.expiresAt>now &&
    value.expiresAt-value.issuedAt<=15000 && Number.isSafeInteger(value.generation) && value.generation>0 &&
    value.method==="GET" && request.method==="GET" &&
    value.path===new URL(request.url).pathname && !new URL(request.url).search &&
    value.cookieHash===hashText(request.headers.get("Cookie")??""), "native_readback_scope", 403);
  const secret=bytes(key);
  try {
    const cryptoKey=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const signature=Uint8Array.from(mac.match(/../g)!, x=>parseInt(x,16));
    insist(await crypto.subtle.verify("HMAC",cryptoKey,signature,new TextEncoder().encode(raw)),"native_readback_authentication",403);
  } finally {secret.fill(0);}
  insist(value.expiresAt>Date.now(),"native_readback_expired",403);
  return value;
}
