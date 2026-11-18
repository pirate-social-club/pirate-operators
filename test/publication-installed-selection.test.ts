import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hashText } from "../packages/community/common.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { publicationSelectionHash } from "../services/publication-app-selection.ts";
import {
  installFirstPublicationSelection,
  installPublicationSelection,
  loadPublicationInstallation,
  type PublicationInstallationSpec,
} from "../services/publication-installed-selection.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
function initial(f: Fixture): PublicationInstallationSpec {
  const release = structuredClone(f.authority.release);
  return {
    schema: "pirate.publication-installation/1",
    communityId: f.context.communityId,
    installationId: release.source.installationId,
    origin: f.context.origin,
    incarnation: "1",
    installedBindingSha256: digest("installed-binding-1"),
    active: publicationSelectionHash(release),
    entries: [{ release, transportRef: "operator-primary" }],
    previous: null,
  };
}
async function evidence(t: TestContext, f: Fixture, label: string) {
  const selections = (
    await f.db
      .prepare(
        "SELECT community_id,installation_id,incarnation,installed_binding_sha256,selection_sha256,active_release_sha256 FROM publication_v1_installed_selection",
      )
      .all()
  ).results;
  const releases = (
    await f.db
      .prepare(
        "SELECT community_id,release_sha256,transport_ref,admitted_binding_sha256 FROM publication_v1_release_archive ORDER BY release_sha256",
      )
      .all()
  ).results;
  const value = {
    schema: "pirate.publication-installed-selection-evidence/1",
    label,
    selections,
    releases,
    commandCount: (await f.rows()).length,
    operatorNonce: f.store().get("op:nonce") ?? null,
  };
  const path = ".local/publication-app-integration/" + label + ".json",
    bytes = JSON.stringify(value, null, 2) + "\n";
  await mkdir(".local/publication-app-integration", { recursive: true });
  await writeFile(path, bytes);
  t.diagnostic(JSON.stringify({ artifact: path, sha256: hashText(bytes) }));
}

test(
  "trusted installation retains exact release and transport bytes and reloads its pinned selection",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t, { installSelection: false });
    try {
      const spec = initial(f),
        mounted = await installPublicationSelection(f.ports.db, spec);
      assert.equal(mounted.catalog.active, spec.active);
      assert.deepEqual(
        mounted.catalog.get(spec.active!),
        spec.entries[0].release,
      );
      assert.equal(mounted.transportFor(spec.active!), "operator-primary");
      const loaded = await loadPublicationInstallation(
        f.ports.db,
        mounted.expected,
      );
      assert.deepEqual(loaded.expected, mounted.expected);
      assert.deepEqual(
        loaded.catalog.get(spec.active!),
        spec.entries[0].release,
      );
      await loaded.check();
      const repeated = await installPublicationSelection(f.ports.db, spec);
      assert.deepEqual(repeated.expected, mounted.expected);
      assert.equal(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM publication_v1_release_archive")
          .first("n"),
        1,
      );
      assert.equal(
        await f.db
          .prepare("SELECT incarnation FROM publication_v1_installed_selection")
          .first("incarnation"),
        1,
      );
    } finally {
      await evidence(t, f, "installed-selection-reload");
    }
  },
);

test(
  "competing initial installation CAS retains only the winning archive and selection",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t, { installSelection: false });
    try {
      const a = initial(f),
        b = structuredClone(a);
      b.entries[0].release.fee.cap = "2000000";
      b.active = publicationSelectionHash(b.entries[0].release);
      b.installedBindingSha256 = digest("competing-installed-binding");
      const outcomes = await Promise.allSettled([
        installPublicationSelection(f.ports.db, a),
        installPublicationSelection(f.ports.db, b),
      ]);
      const winners = outcomes.filter((r) => r.status === "fulfilled");
      assert.equal(winners.length, 1);
      assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
      const winner = winners[0];
      assert.equal(winner.status, "fulfilled");
      assert.equal(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM publication_v1_release_archive")
          .first("n"),
        1,
      );
      const selected = await f.db
        .prepare(
          "SELECT active_release_sha256 FROM publication_v1_installed_selection",
        )
        .first("active_release_sha256");
      assert.equal(selected, winner.value.catalog.active);
      const loser = selected === a.active ? b : a;
      assert.equal(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM publication_v1_release_archive WHERE release_sha256=?",
          )
          .bind(loser.active)
          .first("n"),
        0,
      );
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal((await f.rows()).length, 0);
    } finally {
      await evidence(t, f, "installed-selection-competing-cas");
    }
  },
);

test(
  "disable and re-enable retain originals while old installations fail despite the same active hash",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t, { installSelection: false });
    try {
      const a = initial(f),
        first = await installPublicationSelection(f.ports.db, a);
      Object.assign(f.ports, { installation: first, catalog: first.catalog });
      const prepared = await f.prepare("retained-original");
      assert.equal(prepared.status, 200);
      const before = (await f.rows()).map((r) => canonical(r));
      const off: PublicationInstallationSpec = {
        ...a,
        incarnation: "2",
        installedBindingSha256: digest("binding-off"),
        active: null,
        previous: first.expected,
      };
      const disabled = await installPublicationSelection(f.ports.db, off);
      assert.equal(disabled.catalog.active, null);
      assert.deepEqual(disabled.catalog.get(a.active!), a.entries[0].release);
      assert.equal(disabled.transportFor(a.active!), "operator-primary");
      await assert.rejects(first.check(), /publication_installation_changed/);
      await assert.rejects(
        loadPublicationInstallation(f.ports.db, first.expected),
        /publication_installation_changed/,
      );
      const on: PublicationInstallationSpec = {
        ...a,
        incarnation: "3",
        installedBindingSha256: digest("binding-on"),
        previous: disabled.expected,
      };
      const current = await installPublicationSelection(f.ports.db, on);
      assert.equal(current.catalog.active, a.active);
      await assert.rejects(first.check(), /publication_installation_changed/);
      await assert.rejects(
        disabled.check(),
        /publication_installation_changed/,
      );
      await current.check();
      assert.deepEqual(
        (await f.rows()).map((r) => canonical(r)),
        before,
      );
      assert.equal(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM publication_v1_release_archive")
          .first("n"),
        1,
      );
      await assert.rejects(
        installPublicationSelection(f.ports.db, a),
        /publication_installation_changed/,
      );
    } finally {
      await evidence(t, f, "installed-selection-disabled-aba");
    }
  },
);

test(
  "retained source or transport cannot be replaced and a losing install leaves its predecessor intact",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t, { installSelection: false });
    try {
      const a = initial(f),
        first = await installPublicationSelection(f.ports.db, a);
      const replaced: PublicationInstallationSpec = {
        ...structuredClone(a),
        incarnation: "2",
        installedBindingSha256: digest("changed-route-binding"),
        previous: first.expected,
      };
      replaced.entries[0].transportRef = "operator-replacement";
      await assert.rejects(
        installPublicationSelection(f.ports.db, replaced),
        /publication_retained_release_changed/,
      );
      const omitted: PublicationInstallationSpec = {
        ...replaced,
        entries: [],
        active: null,
      };
      await assert.rejects(
        installPublicationSelection(f.ports.db, omitted),
        /publication_retained_release_missing/,
      );
      await first.check();
      const raw = await f.db
        .prepare(
          "SELECT release_json,transport_ref FROM publication_v1_release_archive",
        )
        .first<{ release_json: string; transport_ref: string }>();
      assert.deepEqual(raw, {
        release_json: canonical(a.entries[0].release),
        transport_ref: "operator-primary",
      });
      await assert.rejects(
        f.db
          .prepare(
            "UPDATE publication_v1_release_archive SET transport_ref='other'",
          )
          .run(),
        /publication_release_archive_immutable/,
      );
      await assert.rejects(
        f.db.prepare("DELETE FROM publication_v1_release_archive").run(),
        /publication_release_archive_immutable/,
      );
      await assert.rejects(
        f.db.prepare("DELETE FROM publication_v1_installed_selection").run(),
        /publication_installation_immutable/,
      );
    } finally {
      await evidence(t, f, "installed-selection-immutable-retention");
    }
  },
);

test("ordinary first consent selection supports both Dance prepares on the same authenticated session", { timeout: 30000 }, async t => {
  const f = await publicationAppFixture(t, { trustedFirstSelection: true, safeLag: 2n });
  const caps = await f.call("capabilities");
  assert.equal(caps.status, 200);
  assert.equal(caps.value.profile, "publication-consent-v1");
  assert.equal(caps.value.privatePractice, "independent-admission");
  const purposes = ["dance-review-attribution", "dance-verdict"] as const;
  assert.deepEqual(caps.value.purposes, [...purposes]);
  for (const purpose of purposes) {
    const pending = await f.prepare("native-first-" + purpose, purpose);
    assert.equal(pending.status, 503);
    assert.equal(pending.value.error, "publication_observation_pending");
    assert.equal(pending.value.walletRequest, undefined);
  }
  const originals = await f.rows();
  assert.equal(originals.length, 2);
  f.authority.advanceSafe(f.now());
  for (const purpose of purposes) {
    const requestId = "native-first-" + purpose;
    const prepared = await f.prepare(requestId, purpose);
    assert.equal(prepared.status, 200);
    assert.ok(prepared.value.walletRequest);
    const same = await f.prepare(requestId, purpose);
    assert.equal(same.status, 200);
    assert.deepEqual(same.value.walletRequest, prepared.value.walletRequest);
    assert.equal(same.value.commandId, prepared.value.commandId);
  }
  const after = await f.rows();
  assert.deepEqual(after.map(row => row.command_id).sort(), originals.map(row => row.command_id).sort());
  assert(after.every(row => row.signature === null && row.accepted_json === null));
  assert.equal(f.operatorCalls.length, 0);
});

test("ordinary first consent admits only the winner's archive on a competing D1 batch", { timeout: 30000 }, async t => {
  const f = await publicationAppFixture(t, { installSelection: false });
  const a = initial(f), b = structuredClone(a);
  await t.test("expiry after archive insertion rolls back the whole first selection", async test => {
    const db = new MemorySqliteD1();
    test.after(() => db.close());
    db.sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE setup_schema(version INTEGER)");
    for (const file of ["0002_first_song", "0020_publication_consent", "0021_publication_installed_selection"]) {
      db.sqlite.exec(await readFile(new URL(`../apps/community-wizard/infra/migrations/${file}.sql`, import.meta.url), "utf8"));
    }
    db.sqlite.prepare("INSERT INTO application_identity VALUES(1,?,?)").run(a.communityId, a.origin);
    const cutoffSeconds = Math.ceil(Date.now() / 1000) + 60;
    const epochs = [cutoffSeconds - 1, cutoffSeconds - 1, cutoffSeconds];
    let clockReads = 0, archiveWritten = false;
    db.sqlite.function("unixepoch", (unit) => {
      assert.equal(unit, "subsec");
      const second = epochs[clockReads++];
      assert.equal(typeof second, "number");
      return second ?? null;
    });
    db.sqlite.function("observe_archive_write", () => { archiveWritten = true; return null; });
    db.sqlite.exec(`CREATE TEMP TRIGGER observe_archive AFTER INSERT ON publication_v1_release_archive
      BEGIN SELECT observe_archive_write(); END`);
    await assert.rejects(installFirstPublicationSelection(db.asD1(), a, cutoffSeconds * 1000), /NOT NULL.*manifest_json/);
    assert.equal(clockReads, 3);
    assert.equal(archiveWritten, true);
    assert.equal(db.count("publication_v1_release_archive"), 0);
    assert.equal(db.count("publication_v1_installed_selection"), 0);
    assert.equal(db.count("publication_v1_commands"), 0);
  });
  b.entries[0]!.release.fee.cap = (BigInt(b.entries[0]!.release.fee.cap) + 1n).toString();
  b.active = publicationSelectionHash(b.entries[0]!.release);
  await assert.rejects(installFirstPublicationSelection(f.ports.db, a, Date.now() - 1), /publication_first_selection_expired/);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM publication_v1_release_archive").first("n"), 0);
  const before = Date.now() + 60000;
  const outcomes = await Promise.allSettled([installFirstPublicationSelection(f.ports.db, a, before),
    installFirstPublicationSelection(f.ports.db, b, before)]);
  const admitted = outcomes.filter(row => row.status === "fulfilled");
  assert.equal(admitted.length, 1);
  const rows = await f.db.prepare("SELECT release_sha256 FROM publication_v1_release_archive").all();
  assert.deepEqual(rows.results, [{ release_sha256: admitted[0]!.value.catalog.active }]);
  assert.equal((await f.rows()).length, 0);
});
