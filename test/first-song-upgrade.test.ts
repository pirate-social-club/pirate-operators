import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertFirstSongUpgrade } from "../harness/first-song-upgrade.ts";
import { releaseGrantDigest } from "../packages/release/grant.ts";
import type { ReleaseGrant } from "../packages/release/authority.ts";
import type { Hex } from "viem";

for (const kind of ["application", "managed"] as const) {
  test(`functional ${kind} transition permits only the exact idle baseline, additive schema and bounded one-song scope`, async () => {
    const name = kind === "application" ? "application" : "moderation",
      suffix = kind === "application" ? "v3" : "v4";
    const previous = JSON.parse(
        await readFile(
          `docs/deployments/first-song-managed-20261105.${name}-plan-${suffix}.json`,
          "utf8",
        ),
      ).profile,
      candidate = JSON.parse(
        await readFile(
          `docs/deployments/first-song-managed-20261105.${name}-plan-${kind === "application" ? "v4" : "v5"}.json`,
          "utf8",
        ),
      ).profile;
    assert.doesNotThrow(() =>
      assertFirstSongUpgrade(previous, candidate, kind),
    );
    const variants = [
      { ...candidate, accountId: "unrelated-account" },
      {
        ...candidate,
        bounds: { ...candidate.bounds, registrationTransactions: 2 },
      },
      { ...candidate, migrations: [...candidate.migrations, "unreviewed.sql"] },
      { ...candidate, extraCredential: "unrelated" },
      {
        ...candidate,
        stateProtection: {
          ...candidate.stateProtection,
          environment: "production",
        },
      },
    ];
    const grant = structuredClone(candidate.releaseGrant) as ReleaseGrant;
    grant.recipient = grant.registration.recipient =
      "0x1111111111111111111111111111111111111111";
    grant.sha256 = releaseGrantDigest(grant);
    grant.pins.sha256 = grant.sha256;
    grant.registration.sha256 = grant.sha256 as Hex;
    variants.push({ ...candidate, releaseGrant: grant });
    if (kind === "application")
      variants.push({
        ...candidate,
        queueConsumer: { ...candidate.queueConsumer, queueId: "unrelated" },
      });
    else {
      variants.push({
        ...candidate,
        secretNames: [...candidate.secretNames, "NEW_CREDENTIAL"],
      });
      variants.push({
        ...candidate,
        registrationCredential: {
          ...candidate.registrationCredential,
          targetChain: 1514,
        },
      });
    }
    for (const changed of variants)
      assert.throws(() => assertFirstSongUpgrade(previous, changed, kind));
    assert.throws(
      () =>
        assertFirstSongUpgrade(
          { ...previous, bundleBytes: 1 },
          candidate,
          kind,
        ),
      /baseline_changed/,
    );
  });
}
