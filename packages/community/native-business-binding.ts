import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { insist, canonical, hashText, exact, object } from "./common.ts";
import { originalLinuxProfileFrom } from "../community-setup/linux-create-profile.ts";
import type { ProfileAdmission,CurrentAdmission } from "../../deploy/linux/full-profile-authority.ts";
import type { SignedRecord, TrustAnchor } from "../../deploy/linux/installed-records.ts";

export interface NativeOriginal {
  schema: "pirate.native-application-original/1";
  record: SignedRecord<ProfileAdmission>;
  release: SignedRecord<{schema:"pirate.complete-linux-release/1";sourceDigest:string;artifactDigest:string;graph:{installationId:string;durableScope:string}}>;
  trust: TrustAnchor;
  durableScope: string;
}
export type NativeBusinessKind = "session" | "media" | "learning";
export const nativeCanonical = (value: unknown) => canonical(value);
export const nativeDigest = (value: unknown) => hashText(nativeCanonical(value)).slice(2);
const binary = (value: string, url = false, status:403|503=503) => {
  const text = url ? value.replaceAll("-", "+").replaceAll("_", "/") : value;
  const decoded=Uint8Array.from(atob(text), c => c.charCodeAt(0));
  if(url)insist(decoded.length===64 && btoa(String.fromCharCode(...decoded)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"")===value,
    "native_signature_encoding",status);
  return decoded;
};

async function verifyNativeRecord(record:SignedRecord<unknown>,trust:TrustAnchor,status:403|503=503){
  exact(object(record),["schema","keyId","body","signature"]);
  insist(record.schema==="pirate.local-signed-record/1" && record.keyId===trust.keyId,"native_original_issuer",status);
  const key=await crypto.subtle.importKey("spki",binary(trust.spki),"Ed25519",false,["verify"]);
  const digest=Uint8Array.from(nativeDigest(record.body).match(/../g)!,x=>parseInt(x,16));
  insist(await crypto.subtle.verify("Ed25519",key,binary(record.signature,true,status),digest),"native_original_signature",status);
}
export async function nativeCurrent(record:SignedRecord<CurrentAdmission>,original:NativeOriginal){
  await verifyNativeRecord(record,original.trust,403);
  const current=record.body,body=original.record.body;
  insist(current.installationId===body.installationId && Number.isSafeInteger(current.generation) &&
    current.generation>=body.generation && Number.isSafeInteger(current.issuedAt) && Number.isSafeInteger(current.expiresAt) &&
    current.issuedAt<=Date.now() && current.expiresAt>Date.now() &&
    current.profileDigests.includes(body.profileDigest) && !current.revokedRecordIds.includes(body.recordId) &&
    nativeCanonical(current.resourceIdentity)===nativeCanonical(body.profile.identity),"native_current_authority_changed",403);
  return current;
}

/** Trust is a server binding produced by the installed launch path, never HTTP input. */
export async function nativeOriginal(raw: string): Promise<NativeOriginal> {
  insist(raw.length <= 1024 * 1024, "native_original_size", 503);
  const input: NativeOriginal = JSON.parse(raw), signed = input.record;
  exact(object(input),["schema","record","release","trust","durableScope"]);
  exact(object(input.trust),["keyId","spki"]);
  insist(input.schema === "pirate.native-application-original/1" &&
    signed.schema === "pirate.local-signed-record/1" && signed.keyId === input.trust.keyId &&
    /^[a-f0-9]{64}$/.test(input.durableScope), "native_original_required", 503);
  await verifyNativeRecord(signed,input.trust);await verifyNativeRecord(input.release,input.trust);
  const original = signed.body, profile = originalLinuxProfileFrom(original.profile);
  exact(object(original),["installationId","requestId","generation","recordId","issuedAt","expiresAt","profile","profileDigest","outcome"]);
  insist(nativeCanonical(profile) === nativeCanonical(original.profile) &&
    nativeDigest(profile) === original.profileDigest && original.outcome === "authorized-profile" &&
    original.installationId === profile.infrastructure.mapping.linuxInstallationId &&
    input.release.body.schema==="pirate.complete-linux-release/1" && input.release.body.graph.installationId===original.installationId &&
    input.release.body.graph.durableScope===input.durableScope &&
    input.release.body.sourceDigest===profile.runtime.sourceDigest && input.release.body.artifactDigest===profile.runtime.artifactDigest &&
    Number.isSafeInteger(original.issuedAt) && Number.isSafeInteger(original.expiresAt) &&
    original.issuedAt<=Date.now() && original.expiresAt>original.issuedAt &&
    Number.isSafeInteger(original.generation) && original.generation > 0 &&
    original.requestId.length > 0 && original.recordId.length > 0,
    "native_original_scope", 503);
  return input;
}

/** Additive immutable scope metadata. It stores no completion/outcome or readiness. */
export async function captureNativeBusiness(
  db: D1Database, kind: NativeBusinessKind, recordId: string, accountId: string,
  requestId: string, onlyInserted = true, loginSignature?: string,
): Promise<D1PreparedStatement[]> {
  const present = await db.withSession("first-primary").prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name='native_application_original'",
  ).first();
  if (!present) return []; // Existing non-native deployments have no native proof.
  if (kind === "session") {
    insist(loginSignature && /^0x[0-9a-f]+$/i.test(loginSignature),"native_verified_login_signature",503);
    return [db.prepare(`INSERT INTO native_business_bindings(kind,record_id,account_id,request_id,original_digest,session_hash,proof_json)
    SELECT 'session',s.session_hash,s.account_id,c.challenge_id,o.original_digest,s.session_hash,json_object('message',c.message,'signature',?)
    FROM native_application_original o JOIN community_sessions s ON s.session_hash=?
    JOIN credential_bindings k ON k.binding_id=s.binding_id AND k.account_id=s.account_id
    JOIN login_challenges c ON c.challenge_id=? AND c.subject=k.subject AND c.community_id=s.community_id
      AND c.community_origin=s.community_origin AND c.consumed=0
      AND s.community_id=json_extract(o.original_json,'$.record.body.profile.identity.communityId')
      AND s.community_origin=json_extract(o.original_json,'$.record.body.profile.settings.origin')
    WHERE o.singleton=1 ON CONFLICT(kind,record_id) DO NOTHING`).bind(loginSignature.toLowerCase(),recordId,requestId)];
  }
  const definition = kind === "media"
    ? {table:"community_media",key:"id",column:"media_id"}
    : {table:"study_lessons",key:"lesson_id",column:"lesson_id"};
  return [db.prepare(`INSERT INTO native_business_bindings(kind,record_id,account_id,request_id,original_digest,${definition.column})
    SELECT ?,b.${definition.key},b.account_id,b.request_id,o.original_digest,b.${definition.key} FROM native_application_original o
    JOIN ${definition.table} b ON b.${definition.key}=? AND b.account_id=? AND b.request_id=?
    WHERE o.singleton=1 AND b.community_id=json_extract(o.original_json,'$.record.body.profile.identity.communityId')
    ${onlyInserted ? "AND changes()=1" : ""}
    ON CONFLICT(kind,record_id) DO NOTHING`).bind(kind, recordId, accountId, requestId)];
}

/** Same atomic reservation batch; the persisted idempotency key/hash, never an
 * observation query/body, supplies the original media business identity. */
export async function captureNativeSubmission(db:D1Database,id:string,account:string,key:string,
  profile:{communityId:string;configurationRevision:number;chainId:number;postsContract:string;publisher:string;moderationSigner:string}){
  const present=await db.withSession("first-primary").prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name='native_application_original'",
  ).first();
  if(!present)return [];
  return [db.prepare(`INSERT INTO native_business_bindings(kind,record_id,account_id,request_id,original_digest,submission_id,proof_json)
    SELECT 'submission',s.submission_id,s.account_id,s.idempotency_key,o.original_digest,s.submission_id,
      json_object('requestHash',s.request_hash,'profile',json(?))
    FROM native_application_original o JOIN media_submissions s ON s.submission_id=? AND s.account_id=? AND s.idempotency_key=?
    WHERE o.singleton=1 AND changes()=1
      AND json_extract(o.original_json,'$.record.body.profile.identity.communityId')=?
      AND json_extract(o.original_json,'$.record.body.profile.infrastructure.configuration.configurationRevision')=?
      AND json_extract(o.original_json,'$.record.body.profile.infrastructure.configuration.chainId')=?
      AND json_extract(o.original_json,'$.record.body.profile.infrastructure.configuration.postsContract')=?
      AND json_extract(o.original_json,'$.record.body.profile.infrastructure.configuration.publisher')=?
      AND json_extract(o.original_json,'$.record.body.profile.infrastructure.configuration.policies.moderationSigner')=?
    ON CONFLICT(kind,record_id) DO NOTHING`).bind(nativeCanonical(profile),id,account,key,
      profile.communityId,profile.configurationRevision,profile.chainId,profile.postsContract,profile.publisher,profile.moderationSigner)];
}

/** Called only by the private installed initializer, after the unapplied draft is assigned/applied by Root. */
export async function initializeNativeOriginal(db: D1Database, raw: string) {
  const original = await nativeOriginal(raw), body = original.record.body,
    digest = nativeDigest(original);
  await db.batch([
    db.prepare(`INSERT INTO native_application_original(singleton,original_digest,original_json)
      VALUES(1,?,?) ON CONFLICT(singleton) DO NOTHING`).bind(digest, nativeCanonical(original)),
    db.prepare(`INSERT INTO native_binding_guards(id,valid) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM native_application_original WHERE singleton=1 AND original_digest=? AND original_json=?
    ) THEN 1 ELSE 0 END`).bind(crypto.randomUUID(), digest, nativeCanonical(original)),
    db.prepare(`INSERT INTO application_identity(id,community_id,community_origin) VALUES(1,?,?) ON CONFLICT DO NOTHING`)
      .bind(body.profile.identity.communityId, body.profile.settings.origin),
    db.prepare(`INSERT INTO native_binding_guards(id,valid) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?
    ) THEN 1 ELSE 0 END`).bind(crypto.randomUUID(), body.profile.identity.communityId, body.profile.settings.origin),
  ]);
  return digest;
}
