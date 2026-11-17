import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { hashText } from "../packages/community/common.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { publicationSelectionHash } from "../services/publication-app-selection.ts";
import {
  installPublicationSelection,
  loadPublicationInstallation,
  type PublicationInstallationSpec,
} from "../services/publication-installed-selection.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

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
