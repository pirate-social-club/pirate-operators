import { createHash } from "node:crypto";

// Format observed by api-next; provenance and limits are in docs/very-probe.md.
export const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const CONTEXT = "VeryAI - Palm Verification Timestamp";
export const CONTEXT_ID = "1034873066642566601948846461572930273212113570698";
export const FROM = "1743436800";
export const TO = "2043436800";
export const MAX_BYTES = 1_048_576;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_shape");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error("invalid_shape");
}

function decimal(value: unknown, limit: bigint): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,76})$/.test(value) ||
    BigInt(value) >= limit
  )
    throw new Error("invalid_field");
  return value;
}

function vector(value: unknown, length: number, limit: bigint): string[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error("invalid_shape");
  return value.map((v) => decimal(v, limit));
}

export function scopeSignal(scope: string): string {
  decimal(scope, SCALAR_FIELD);
  return (
    BigInt(`0x${createHash("sha256").update(scope).digest("hex")}`) %
    SCALAR_FIELD
  ).toString();
}

export function queryFor(scope: string, binding: string) {
  decimal(scope, SCALAR_FIELD);
  decimal(binding, 1n << 128n);
  return {
    conditions: [
      { identifier: "val", operation: "IN", value: { from: FROM, to: TO } },
    ],
    options: {
      expiredAtLowerBound: FROM,
      externalNullifier: scope,
      equalCheckId: "0",
      pseudonym: binding,
    },
  };
}

// This checks shape and request binding, NOT the Groth16 proof. The caller must
// independently obtain a valid result from the pinned hosted verifier.
export function boundSubject(
  raw: string,
  scope: string,
  binding: string,
): string {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("proof_too_large");
  const root = object(JSON.parse(raw));
  exactKeys(root, ["proof", "publicSignals"]);
  const proof = object(root.proof);
  exactKeys(proof, ["pi_a", "pi_b", "pi_c", "protocol", "curve"]);
  if (proof.protocol !== "groth16" || proof.curve !== "bn128")
    throw new Error("invalid_protocol");
  vector(proof.pi_a, 3, BASE_FIELD);
  vector(proof.pi_c, 3, BASE_FIELD);
  if (!Array.isArray(proof.pi_b) || proof.pi_b.length !== 3)
    throw new Error("invalid_shape");
  proof.pi_b.forEach((row) => vector(row, 2, BASE_FIELD));
  const s = vector(root.publicSignals, 10, SCALAR_FIELD);
  if (
    s[0] !== "3" ||
    s[1] !== CONTEXT_ID ||
    s[2] === "0" ||
    s[3] !== scopeSignal(scope) ||
    s[4] !== binding ||
    s[5] !== FROM ||
    !["0", "1"].includes(s[7]) ||
    s[8] !== FROM ||
    s[9] !== TO
  )
    throw new Error("proof_binding_mismatch");
  return s[2];
}
