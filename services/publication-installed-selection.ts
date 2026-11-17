import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import { exact, generation, record } from "./publication-command-contract.ts";
import {
  parsePublicationRelease,
  publicationSelectionHash,
  PublicationReleaseCatalog,
  type PublicationAppRelease,
} from "./publication-app-selection.ts";

export interface PublicationMountIdentity {
  schema: "pirate.publication-mount/1";
  communityId: Hex;
  installationId: string;
  origin: string;
  incarnation: string;
  installedBindingSha256: Hex;
  selectionSha256: Hex;
}
export interface PublicationInstallationSpec {
  schema: "pirate.publication-installation/1";
  communityId: Hex;
  installationId: string;
  origin: string;
  incarnation: string;
  installedBindingSha256: Hex;
  active: Hex | null;
  entries: { release: PublicationAppRelease; transportRef: string }[];
  previous: PublicationMountIdentity | null;
}
interface InstalledRow {
  community_id: Hex;
  installation_id: string;
  community_origin: string;
  incarnation: number;
  installed_binding_sha256: Hex;
  selection_sha256: Hex;
  active_release_sha256: Hex | null;
  manifest_json: string;
}
interface ArchiveRow {
  community_id: Hex;
  release_sha256: Hex;
  release_json: string;
  transport_ref: string;
  admitted_binding_sha256: Hex;
}
const MAX = 9007199254740991;
function context(v: Record<string, unknown>) {
  consentDigest(v.communityId);
  check(
    typeof v.installationId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(v.installationId),
    "publication_installation_invalid",
  );
  check(typeof v.origin === "string", "publication_installation_invalid");
  const u = new URL(v.origin);
  check(
    u.origin === v.origin &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))),
    "publication_installation_invalid",
  );
  const n = generation(v.incarnation);
  check(n > 0 && n < MAX, "publication_installation_exhausted");
  consentDigest(v.installedBindingSha256);
}
function mount(value: unknown): PublicationMountIdentity {
  const v = record(value);
  exact(v, [
    "schema",
    "communityId",
    "installationId",
    "origin",
    "incarnation",
    "installedBindingSha256",
    "selectionSha256",
  ]);
  check(
    v.schema === "pirate.publication-mount/1",
    "publication_installation_invalid",
  );
  context(v);
  consentDigest(v.selectionSha256);
  return JSON.parse(canonical(v)) as PublicationMountIdentity;
}
function installation(value: unknown): PublicationInstallationSpec {
  const v = record(value);
  exact(v, [
    "schema",
    "communityId",
    "installationId",
    "origin",
    "incarnation",
    "installedBindingSha256",
    "active",
    "entries",
    "previous",
  ]);
  check(
    v.schema === "pirate.publication-installation/1",
    "publication_installation_invalid",
  );
  context(v);
  check(
    Array.isArray(v.entries) && v.entries.length <= 128,
    "publication_release_catalog_too_large",
  );
  const entries = v.entries.map((item) => {
    const e = record(item);
    exact(e, ["release", "transportRef"]);
    check(
      typeof e.transportRef === "string" &&
        /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(e.transportRef),
      "publication_transport_reference_invalid",
    );
    const release = parsePublicationRelease(e.release);
    check(
      release.source.communityId === v.communityId,
      "publication_installation_community_changed",
    );
    return { release, transportRef: e.transportRef };
  });
  const hashes = entries.map((e) => publicationSelectionHash(e.release));
  check(
    new Set(hashes).size === hashes.length,
    "publication_retained_release_ambiguous",
  );
  if (v.active !== null) {
    const hash = consentDigest(v.active);
    const i = hashes.indexOf(hash);
    check(i >= 0, "publication_release_missing");
    const active = entries[i]!.release;
    check(
      active.source.installationId === v.installationId &&
        active.configuration.app.origin === v.origin,
      "publication_installation_active_changed",
    );
  }
  const previous = v.previous === null ? null : mount(v.previous);
  check(
    previous === null
      ? v.incarnation === "1"
      : previous.communityId === v.communityId &&
          generation(v.incarnation) === generation(previous.incarnation) + 1,
    "publication_installation_progression",
  );
  const result = { ...v, entries, previous };
  check(
    new TextEncoder().encode(canonical(result)).length <= 4 * 1024 * 1024,
    "publication_installation_too_large",
  );
  return JSON.parse(canonical(result)) as PublicationInstallationSpec;
}
function identity(spec: PublicationInstallationSpec): PublicationMountIdentity {
  return {
    schema: "pirate.publication-mount/1",
    communityId: spec.communityId,
    installationId: spec.installationId,
    origin: spec.origin,
    incarnation: spec.incarnation,
    installedBindingSha256: spec.installedBindingSha256,
    selectionSha256: digest(spec),
  };
}
const selected = (db: D1Database, communityId: Hex) =>
  db
    .prepare(
      "SELECT * FROM publication_v1_installed_selection WHERE community_id=?",
    )
    .bind(communityId)
    .first<InstalledRow>();
async function archive(db: D1Database, communityId: Hex) {
  const rows = (
    await db
      .prepare(
        "SELECT * FROM publication_v1_release_archive WHERE community_id=? ORDER BY release_sha256 LIMIT 129",
      )
      .bind(communityId)
      .all<ArchiveRow>()
  ).results;
  check(rows.length <= 128, "publication_release_catalog_too_large");
  return rows;
}
function rowMatches(
  row: InstalledRow | null,
  expected: PublicationMountIdentity,
) {
  return (
    row !== null &&
    row.community_id === expected.communityId &&
    row.installation_id === expected.installationId &&
    row.community_origin === expected.origin &&
    String(row.incarnation) === expected.incarnation &&
    row.installed_binding_sha256 === expected.installedBindingSha256 &&
    row.selection_sha256 === expected.selectionSha256
  );
}
function retained(
  spec: PublicationInstallationSpec,
  rows: ArchiveRow[],
  complete: boolean,
) {
  const entries = new Map(
    spec.entries.map((e) => [publicationSelectionHash(e.release), e]),
  );
  for (const row of rows) {
    check(
      row.community_id === spec.communityId,
      "publication_installation_community_changed",
    );
    consentDigest(row.admitted_binding_sha256);
    const release = parsePublicationRelease(JSON.parse(row.release_json));
    check(
      canonical(release) === row.release_json &&
        publicationSelectionHash(release) === row.release_sha256,
      "publication_retained_release_changed",
    );
    const entry = entries.get(row.release_sha256);
    check(entry, "publication_retained_release_missing");
    check(
      canonical(entry.release) === row.release_json &&
        entry.transportRef === row.transport_ref,
      "publication_retained_release_changed",
    );
  }
  if (complete)
    check(rows.length === entries.size, "publication_retained_release_missing");
}
/** Trusted installer only, after the actual signed runtime binding has been
 * verified. No browser handler exposes this mutation or supplies its bytes. */
export async function installPublicationSelection(
  db: D1Database,
  input: unknown,
) {
  const spec = installation(input),
    expected = identity(spec),
    bytes = canonical(spec),
    old = await selected(db, spec.communityId);
  if (rowMatches(old, expected))
    return loadPublicationInstallation(db, expected);
  retained(spec, await archive(db, spec.communityId), false);
  const previous = spec.previous;
  const predicate = previous
    ? `EXISTS(SELECT 1 FROM publication_v1_installed_selection
    WHERE community_id=? AND installation_id=? AND community_origin=? AND incarnation=?
    AND installed_binding_sha256=? AND selection_sha256=?)`
    : "NOT EXISTS(SELECT 1 FROM publication_v1_installed_selection WHERE community_id=?)";
  const values = previous
    ? [
        previous.communityId,
        previous.installationId,
        previous.origin,
        generation(previous.incarnation),
        previous.installedBindingSha256,
        previous.selectionSha256,
      ]
    : [spec.communityId];
  const statements = spec.entries.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO publication_v1_release_archive
    (community_id,release_sha256,release_json,transport_ref,admitted_binding_sha256)
    SELECT ?,?,?,?,? WHERE ${predicate}`,
      )
      .bind(
        spec.communityId,
        publicationSelectionHash(e.release),
        canonical(e.release),
        e.transportRef,
        spec.installedBindingSha256,
        ...values,
      ),
  );
  if (previous)
    statements.push(
      db
        .prepare(
          `UPDATE publication_v1_installed_selection SET installation_id=?,
    community_origin=?,incarnation=?,installed_binding_sha256=?,selection_sha256=?,active_release_sha256=?,manifest_json=?
    WHERE community_id=? AND ${predicate}`,
        )
        .bind(
          spec.installationId,
          spec.origin,
          generation(spec.incarnation),
          spec.installedBindingSha256,
          expected.selectionSha256,
          spec.active,
          bytes,
          spec.communityId,
          ...values,
        ),
    );
  else
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO publication_v1_installed_selection
    (community_id,installation_id,community_origin,incarnation,installed_binding_sha256,selection_sha256,active_release_sha256,manifest_json)
    SELECT ?,?,?,?,?,?,?,? WHERE ${predicate}`,
        )
        .bind(
          spec.communityId,
          spec.installationId,
          spec.origin,
          generation(spec.incarnation),
          spec.installedBindingSha256,
          expected.selectionSha256,
          spec.active,
          bytes,
          ...values,
        ),
    );
  await db.batch(statements);
  return loadPublicationInstallation(db, expected);
}
/** Pinned mount, reconstructed from admitted durable bytes. A stale isolate
 * cannot adopt the latest incarnation merely by querying the database. */
export class PublicationInstallation {
  readonly db: D1Database;
  readonly expected: Readonly<PublicationMountIdentity>;
  readonly catalog: PublicationReleaseCatalog;
  private readonly transports: ReadonlyMap<Hex, string>;
  private constructor(
    db: D1Database,
    expected: PublicationMountIdentity,
    spec: PublicationInstallationSpec,
  ) {
    this.db = db;
    this.expected = Object.freeze({ ...expected });
    this.catalog = new PublicationReleaseCatalog(
      spec.entries.map((e) => e.release),
      spec.active,
    );
    this.transports = new Map(
      spec.entries.map((e) => [
        publicationSelectionHash(e.release),
        e.transportRef,
      ]),
    );
  }
  static async load(db: D1Database, value: unknown) {
    const expected = mount(value),
      row = await selected(db, expected.communityId);
    check(rowMatches(row, expected), "publication_installation_changed");
    const spec = installation(JSON.parse(row!.manifest_json));
    check(
      canonical(spec) === row!.manifest_json &&
        digest(spec) === row!.selection_sha256 &&
        spec.active === row!.active_release_sha256 &&
        canonical(identity(spec)) === canonical(expected),
      "publication_installation_changed",
    );
    retained(spec, await archive(db, expected.communityId), true);
    const result = new PublicationInstallation(db, expected, spec);
    await result.check();
    return result;
  }
  async check() {
    check(
      rowMatches(
        await selected(this.db, this.expected.communityId),
        this.expected,
      ),
      "publication_installation_changed",
    );
  }
  transportFor(releaseHash: Hex) {
    consentDigest(releaseHash);
    const ref = this.transports.get(releaseHash);
    check(ref, "publication_retained_release_missing");
    return ref;
  }
  mountFence() {
    const e = this.expected;
    return {
      sql: `EXISTS(SELECT 1 FROM publication_v1_installed_selection i
      WHERE i.community_id=? AND i.installation_id=? AND i.community_origin=? AND i.incarnation=?
      AND i.installed_binding_sha256=? AND i.selection_sha256=?)`,
      values: [
        e.communityId,
        e.installationId,
        e.origin,
        generation(e.incarnation),
        e.installedBindingSha256,
        e.selectionSha256,
      ],
    };
  }
  /** Concrete same-statement predicate for the accepting application writes. */
  fence(mode: "active" | "retained", releaseHash: Hex) {
    this.transportFor(releaseHash);
    check(
      mode === "active" || mode === "retained",
      "publication_installation_invalid",
    );
    if (mode === "active")
      check(
        this.catalog.active === releaseHash,
        "publication_release_inactive",
      );
    const e = this.expected;
    return {
      sql: `EXISTS(SELECT 1 FROM publication_v1_installed_selection s
      WHERE s.community_id=? AND s.installation_id=? AND s.community_origin=? AND s.incarnation=?
      AND s.installed_binding_sha256=? AND s.selection_sha256=? ${mode === "active" ? "AND s.active_release_sha256=?" : ""}
      AND EXISTS(SELECT 1 FROM publication_v1_release_archive r WHERE r.community_id=s.community_id AND r.release_sha256=?))`,
      values: [
        e.communityId,
        e.installationId,
        e.origin,
        generation(e.incarnation),
        e.installedBindingSha256,
        e.selectionSha256,
        ...(mode === "active" ? [releaseHash] : []),
        releaseHash,
      ],
    };
  }
}
export const loadPublicationInstallation = (
  db: D1Database,
  expected: unknown,
) => PublicationInstallation.load(db, expected);
