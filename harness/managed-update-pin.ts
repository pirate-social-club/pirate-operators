// Dependency-free so that tests can read the pin without the package builder.
// The deployed predecessor is the owner publishing update of November 9:
// its executed plan is pinned byte for byte as v9, its live evidence is the
// owner publishing rollout, and its retained result digest is recorded
// there. Resource identities are unchanged since setup. The previous
// predecessor (0xdaff…, v8, published-recovery rollout) stays committed as
// history.
export const managedUpdate = {
  previousProfileHash:
    "0x36ade674c8f6cf75925c3cdfa07b32ff7ff3e09ba7450a46b7b91f2a5789c1bd",
  previousPlanPath:
    "docs/deployments/first-song-managed-20261105.moderation-plan-v9.json",
  startupEvidencePath:
    "docs/deployments/first-song-managed-20261105.moderation-setup.json",
  previousEvidencePath:
    "docs/deployments/first-song-managed-20261105.owner-publishing-rollout.json",
  requireIdle: false,
  expectedResultSha256:
    "0x13edb1c96397f9f24f925f23390d40a0583886bd04c2f7e58334ae8ed4bfd5e3",
};
