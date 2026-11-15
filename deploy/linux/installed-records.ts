import assert from "node:assert/strict";
import {createPublicKey, verify, sign, createPrivateKey} from "node:crypto";
import {join} from "node:path";
import {privateFile, createJSON, hash, type OperationLease} from "./backend-state.ts";
import {profileDigest} from "./profile-canonical.ts";

export interface SignedRecord<T> { schema: "pirate.local-signed-record/1"; keyId: string; body: T; signature: string }
export interface TrustAnchor { keyId: string; spki: string }
export const canonicalDigest = profileDigest;
export async function readPrivateJSON<T>(path: string): Promise<T> {
  const file = await privateFile(path, 2 ** 20);
  try {
    const a = await file.stat({bigint:true}), bytes = await file.readFile(), b = await file.stat({bigint:true});
    assert(a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs, "record_changed");
    return JSON.parse(bytes.toString("utf8")) as T;
  } finally { await file.close(); }
}
export function verifyRecord<T>(record: SignedRecord<T>, trust: TrustAnchor): T {
  assert(record?.schema==="pirate.local-signed-record/1" && record.keyId===trust.keyId, "record_issuer_mismatch");
  const signature=Buffer.from(record.signature,"base64url");
  assert(signature.length===64 && signature.toString("base64url")===record.signature, "record_signature_encoding");
  const key=createPublicKey({key:Buffer.from(trust.spki,"base64"),format:"der",type:"spki"});
  assert(key.asymmetricKeyType==="ed25519" && verify(null,Buffer.from(canonicalDigest(record.body),"hex"),key,signature), "record_signature_invalid");
  return record.body;
}
export function signRecord<T>(body:T, trust:TrustAnchor, privateKey:Uint8Array):SignedRecord<T> {
  const key=createPrivateKey({key:Buffer.from(privateKey),format:"der",type:"pkcs8"});
  assert(key.asymmetricKeyType==="ed25519");
  const result:SignedRecord<T>={schema:"pirate.local-signed-record/1",keyId:trust.keyId,body,
    signature:sign(null,Buffer.from(canonicalDigest(body),"hex"),key).toString("base64url")};
  verifyRecord(result,trust); return result;
}
export async function immutableRecord<T>(directory:string, name:string, body:T, lease:OperationLease) {
  await lease.assertHeld(); const ref=await createJSON(directory,name,body);
  const actual=await readPrivateJSON<T>(join(directory,ref.relativePath));
  assert.equal(canonicalDigest(actual),canonicalDigest(body)); return ref;
}
export const evidenceId=(value:string)=>hash(value).slice(0,40);


/** Same accepted SPKI transport as verifyRecord; canonical export discards
 * base64 spelling/whitespace and DER encoding aliases. Key IDs are not identity. */
export function canonicalPublicKeyIdentity(trust:TrustAnchor) {
  const key=createPublicKey({key:Buffer.from(trust.spki,"base64"),format:"der",type:"spki"});
  assert(key.asymmetricKeyType==="ed25519","record_key_type_invalid");
  return hash(key.export({format:"der",type:"spki"}));
}
export function assertIndependentTrustAnchors(profile:TrustAnchor,custody:TrustAnchor) {
  assert(profile.keyId!==custody.keyId,"separate_independent_custody_issuer_required");
  assert(canonicalPublicKeyIdentity(profile)!==canonicalPublicKeyIdentity(custody),
    "separate_independent_custody_key_required");
}
