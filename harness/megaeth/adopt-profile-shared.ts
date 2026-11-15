import { insist } from "../../packages/community/common.ts";
import { parseSharedProfileDocument, validateSharedProfile } from "../../packages/community/shared-directory.ts";

// Source profile selection only; cannot rewrite a prior journal or mount.
export function selectSharedProfile(candidate: unknown, previous?: unknown) {
  const profile = validateSharedProfile(candidate);
  insist(previous === undefined, "explicit_existing_installation_migration_required");
  return { profile, releaseAccepted: false as const, migrationExecuted: false as const };
}

export function selectSharedProfileDocument(candidate: unknown, previous?: unknown) {
  return selectSharedProfile(parseSharedProfileDocument(candidate), previous);
}
