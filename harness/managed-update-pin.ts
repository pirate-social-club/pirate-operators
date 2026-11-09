// Dependency-free so that tests can read the pin without the package builder.
// The deployed predecessor is the published-recovery update of November 6:
// its plan is pinned byte for byte as v8, its live evidence is the
// published recovery rollout, and its retained result digest is recorded
// there. Resource identities are unchanged since setup.
export const managedUpdate = {
  previousProfileHash:
    "0xdaff75fad62b99c881e0e50b706e12a3fc8e26264e01f41c9d7494d61d4bc3ea",
  previousPlanPath:
    "docs/deployments/first-song-managed-20261105.moderation-plan-v8.json",
  startupEvidencePath:
    "docs/deployments/first-song-managed-20261105.moderation-setup.json",
  previousEvidencePath:
    "docs/deployments/first-song-managed-20261105.published-recovery-rollout.json",
  requireIdle: false,
  expectedResultSha256:
    "0x87c955ebdd6d79950afbb35a8811691167a7aa1cbf8781ac64093696956992d0",
};
