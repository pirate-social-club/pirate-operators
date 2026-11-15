/** Explicit refusal at the still-missing owning join. No profile is invented
 * from profileSha256, no old registry derivation is admitted, and authenticated
 * archive bytes are never promoted to an authorized compatible deployment. */
export class BackupProfileAuthorityJoinMissing extends Error {
  readonly code = "backup_original_profile_authority_join_missing";
  readonly joins = [
    "apps/community-wizard/server/linux-contracts.ts:RestoreInspection.profile",
    "packages/community-setup/linux-profile.ts:accepted current full-profile codec and original record producer",
    "deploy/linux/wizard-backend.ts:LinuxBackendServices.authority original/current profile admission",
  ] as const;
  constructor() { super("Authenticated full profile bytes still require the actual original producer and current authority binding before inspectBackup can return RestoreInspection.profile."); }
}
export function refuseUnboundRestoreInspection(): never { throw new BackupProfileAuthorityJoinMissing(); }
