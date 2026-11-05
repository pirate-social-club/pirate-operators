import { unb64 } from "../shared.ts";
import {
  activationPayload,
  activationPayloadHash,
  type SealedActivation,
} from "../activation-vault.ts";
import { insist, type Env } from "./store.ts";

export async function retainedActivation(
  env: Pick<Env, "DB">,
  attemptId: string,
  credentialId: string,
) {
  const row = await env.DB.prepare(
    "SELECT record_json FROM activation_recovery WHERE attempt_id=? AND credential_id=?",
  )
    .bind(attemptId, credentialId)
    .first<{ record_json: string }>();
  return row ? (JSON.parse(row.record_json) as SealedActivation) : null;
}
export async function retainActivation(
  env: Pick<Env, "DB">,
  attemptId: string,
  credentialId: string,
  value: unknown,
) {
  insist(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_activation_recovery",
  );
  const record = value as SealedActivation;
  insist(
    Object.keys(record).length === 6 &&
      record.schema === "pirate.creator-activation-recovery/1" &&
      record.attemptId === attemptId &&
      record.credentialId === credentialId &&
      typeof record.payloadHash === "string" &&
      /^[\w-]{43}$/.test(record.payloadHash) &&
      typeof record.nonce === "string" &&
      unb64(record.nonce).length === 12 &&
      typeof record.ciphertext === "string" &&
      record.ciphertext.length <= 1400000 &&
      unb64(record.ciphertext).length >= 17,
    "invalid_activation_recovery",
  );
  const encoded = JSON.stringify(record);
  await env.DB.prepare(
    `INSERT INTO activation_recovery(attempt_id,credential_id,payload_hash,record_json,created)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM attempts WHERE id=? AND credential_id=?) ON CONFLICT(attempt_id) DO NOTHING`,
  )
    .bind(
      attemptId,
      credentialId,
      record.payloadHash,
      encoded,
      Date.now(),
      attemptId,
      credentialId,
    )
    .run();
  const saved = await retainedActivation(env, attemptId, credentialId);
  insist(
    saved && JSON.stringify(saved) === encoded,
    "activation_recovery_conflict",
    409,
  );
  return saved;
}
export async function requireActivationRecovery(
  env: Pick<Env, "DB">,
  attemptId: string,
  credentialId: string,
  input: Record<string, unknown>,
) {
  const saved = await retainedActivation(env, attemptId, credentialId);
  insist(
    saved &&
      saved.payloadHash ===
        (await activationPayloadHash(activationPayload(input))),
    "activation_recovery_required",
    409,
  );
}
