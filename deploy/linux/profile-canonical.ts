import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Profile preimage, not a registry-derived installation identity.
export function canonicalProfile(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalProfile).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ":" + canonicalProfile(item)).join(",") + "}";
  assert(value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value), "backup_profile_preimage_invalid");
  return JSON.stringify(value);
}
export const profileDigest = (value: unknown) => createHash("sha256").update(canonicalProfile(value)).digest("hex");
