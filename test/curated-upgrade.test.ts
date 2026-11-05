import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertCuratedUpgrade } from "../harness/curated-upgrade.ts";
import { releaseGrantDigest } from "../packages/release/grant.ts";

for (const side of ["application", "managed"] as const)
  test(`held ${side} update preserves aggregate grant and resource intent`, async () => {
    const prefix = "docs/deployments/first-song-managed-20261105.",
      name = side === "application" ? "application" : "moderation",
      previous = JSON.parse(
        await readFile(prefix + name + "-plan-v6.json", "utf8"),
      ).profile,
      grant = JSON.parse(
        await readFile(prefix + "owner-curated-grant.json", "utf8"),
      ),
      state = JSON.parse(await readFile(prefix + "held-state.json", "utf8")),
      candidate = {
        ...previous,
        curatedState: state,
        releaseGrant: grant,
        migrations: [
          ...previous.migrations,
          ...(side === "application"
            ? ["0006_song_stems.sql", "0007_owner_curated.sql"]
            : ["0003_owner_curated.sql"]),
        ],
      };
    assert.doesNotThrow(() => assertCuratedUpgrade(previous, candidate, side));
    for (const mutate of [
      (g: typeof grant) => {
        g.pins.maximumAdds = 6;
      },
      (g: typeof grant) => {
        g.registration.maximumTotalFee = "200000000000000";
      },
      (g: typeof grant) => {
        g.pins.period = g.registration.period = "new-allowance";
      },
      (g: typeof grant) => {
        g.expiresAt++;
        g.registration.expiresAt = g.expiresAt;
      },
    ]) {
      const changed = structuredClone(grant);
      mutate(changed);
      changed.sha256 = releaseGrantDigest(changed);
      changed.pins.sha256 = changed.registration.sha256 = changed.sha256;
      assert.throws(() =>
        assertCuratedUpgrade(
          previous,
          { ...candidate, releaseGrant: changed },
          side,
        ),
      );
    }
    assert.throws(
      () =>
        assertCuratedUpgrade(previous, { ...candidate, resources: {} }, side),
      /resource_or_credential/,
    );
    assert.throws(
      () =>
        assertCuratedUpgrade(
          previous,
          { ...candidate, curatedState: { ...state, managed: {} } },
          side,
        ),
      /baseline/,
    );
  });
