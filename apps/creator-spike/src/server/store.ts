import { b64, hash, randomToken, unb64, type WalletRecord } from "../shared.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SUI_OPERATOR_SECRET_KEY: string;
  LOCAL_TEST_DIAGNOSTICS?: string;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function insist(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new HttpError(status, message);
}
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  insist(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "json_required",
    415,
  );
  const reader = request.body?.getReader();
  insist(reader, "body_required");
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 2_000_000) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  insist(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    "object_required",
  );
  return parsed as Record<string, unknown>;
}
export function str(
  body: Record<string, unknown>,
  key: string,
  max = 4096,
): string {
  const value = body[key];
  insist(
    typeof value === "string" && value.length > 0 && value.length <= max,
    `invalid_${key}`,
  );
  return value;
}
export function bytes(
  body: Record<string, unknown>,
  key: string,
  max: number,
): Uint8Array<ArrayBuffer> {
  const value = unb64(str(body, key, Math.ceil((max * 4) / 3) + 4));
  insist(value.length <= max, `invalid_${key}`);
  return value;
}
export function cookieToken(
  request: Request,
  kind: "community" | "creator",
): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`__Host-${kind}_session=`))
    ?.split("=")[1];
}
export async function session(
  request: Request,
  env: Env,
  kind: "community" | "creator",
) {
  const token = cookieToken(request, kind);
  insist(token, "session_required", 401);
  const digest = await hash(token);
  const found = await env.DB.prepare(
    "SELECT * FROM sessions WHERE hash = ? AND kind = ? AND expires > ?",
  )
    .bind(digest, kind, Date.now())
    .first<{ hash: string; kind: string; account: string; expires: number }>();
  insist(found, "session_required", 401);
  return found;
}
export async function newSession(
  env: Env,
  kind: "community" | "creator",
  account: string,
) {
  const token = randomToken(),
    seconds = kind === "community" ? 30 * 86400 : 1800;
  await env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)")
    .bind(await hash(token), kind, account, Date.now() + seconds * 1000)
    .run();
  return `__Host-${kind}_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export async function challenge(
  env: Env,
  kind: string,
  payload: Record<string, unknown>,
) {
  const id = randomToken();
  await env.DB.prepare("INSERT INTO challenges VALUES (?, ?, ?, ?)")
    .bind(id, kind, JSON.stringify(payload), Date.now() + 300_000)
    .run();
  return id;
}
export async function consumeChallenge(
  env: Env,
  id: string,
  kind: string,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "DELETE FROM challenges WHERE id = ? AND kind = ? AND expires > ? RETURNING payload",
  )
    .bind(id, kind, Date.now())
    .first<{ payload: string }>();
  insist(row, "challenge_expired_or_used");
  return JSON.parse(row.payload);
}
export interface CredentialRow {
  id: string;
  cose_key: string;
  counter: number;
  sui_public_key: string;
  sui_address: string;
  sealed_seed: string;
  status: WalletRecord["status"];
  dwallet_id: string | null;
  cap_id: string | null;
  share_id: string | null;
  evm_public_key: string | null;
  evm_address: string | null;
  authenticated_at: number | null;
  activated_at: number | null;
}
export async function credential(env: Env, id: string): Promise<CredentialRow> {
  const row = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
    .bind(id)
    .first<CredentialRow>();
  insist(row, "wallet_not_found", 404);
  return row;
}
export function record(row: CredentialRow): WalletRecord {
  return {
    credentialId: row.id,
    suiPublicKey: row.sui_public_key,
    suiAddress: row.sui_address,
    sealedSeed: JSON.parse(row.sealed_seed),
    status: row.status,
    dWalletId: row.dwallet_id ?? undefined,
    capId: row.cap_id ?? undefined,
    shareId: row.share_id ?? undefined,
    evmPublicKey: row.evm_public_key ?? undefined,
    evmAddress: row.evm_address ?? undefined,
  };
}
export interface LinkRow {
  id: string;
  session_hash: string;
  account: string;
  origin: string;
  state: string;
  verifier_hash: string;
  expires: number;
  credential_id: string | null;
  code_hash: string | null;
  consumed: number;
}
export async function link(env: Env, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM links WHERE id = ? AND expires > ? AND consumed = 0",
  )
    .bind(id, Date.now())
    .first<LinkRow>();
  insist(row, "connection_expired", 401);
  return row;
}
export async function bindCredentialToLink(
  env: Env,
  id: string,
  credentialId: string,
) {
  const l = await link(env, id);
  const existing = await env.DB.prepare(
    "SELECT credential_id FROM bindings WHERE account = ?",
  )
    .bind(l.account)
    .first<{ credential_id: string }>();
  insist(
    !existing || existing.credential_id === credentialId,
    "wrong_creator_passkey",
    403,
  );
  const result = await env.DB.prepare(
    "UPDATE links SET credential_id = ? WHERE id = ? AND (credential_id IS NULL OR credential_id = ?) AND consumed = 0",
  )
    .bind(credentialId, id, credentialId)
    .run();
  insist(result.meta.changes === 1, "connection_already_bound", 409);
}
