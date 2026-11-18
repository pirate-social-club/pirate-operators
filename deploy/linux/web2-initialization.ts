import { LOCAL_POSTS_CUSTODY_SCHEMA } from "../../packages/community/local-posts-custody.ts";

/** Explicit fresh-Web2 schema selection, not a numbered migration or upgrade.
 * The installed release pins the complete plan. Owning SQL guards and the
 * initialization ledger commit in one real D1 batch, including trigger bodies. */
export interface Web2SchemaPlan {
  schema: "pirate.linux-web2-schema/1";
  overlays: Array<{
    name: string;
    sha256: string;
    sql: string;
    statements: string[];
  }>;
}
const names = [
  "packages/community/catalog-phase-rebuild.sql",
  "packages/community/catalog-obligation.sql",
  "packages/community/native-business.sql",
];
const consentMigrations = [
  ["0020_publication_consent.sql", "e9cac21b952f917147693036616052abb5442b297beada5937ce094f20ce9690"],
  ["0021_publication_installed_selection.sql", "bd8d82b8a834c686b6349a20771229d0a8b0e29455777b9c9507d92001b4ee11"],
] as const;

/** The bootstrap calls this after verifying numbered source bytes and ledger. */
export function selectWeb2PublicationConsent(migrations: readonly { name: string; sha256: string }[]) {
  const matches = migrations.filter(row => consentMigrations.some(([name]) => row.name === name));
  if (!matches.length) return false;
  const start = migrations.findIndex(row => row.name === consentMigrations[0][0]);
  if (matches.length !== consentMigrations.length || start < 0 ||
    !consentMigrations.every(([name, sha256], i) =>
      migrations[start + i]?.name === name && migrations[start + i]?.sha256 === sha256))
    throw Error("web2_publication_consent_migrations_changed");
  return true;
}

const catalogConsentContext = "UPDATE catalog_phase_schema_guard SET publication_consent=";
const defaultCatalogConsentContext = "-- catalog-phase-statement\n" + catalogConsentContext + "0 WHERE singleton=1;";
const defaultNativeConsentContext = "WITH publication_consent_context(enabled) AS (VALUES (0)),";
const boundNativeConsentContext = "WITH publication_consent_context(enabled) AS (VALUES (?)),";
const digest = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
const schemaDocument = `(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM
  (SELECT type,name,tbl_name,sql FROM sqlite_schema
   WHERE name<>'_pirate_web2_transition_guard' ORDER BY type,name,tbl_name))`;
const guard =
  "CREATE TABLE _pirate_web2_transition_guard(valid INTEGER NOT NULL CONSTRAINT web2_schema_refusal CHECK(valid=1))";

export async function initializeWeb2Schema(
  db: D1Database,
  input: Web2SchemaPlan,
  releaseSha256: string,
  options: { postsCustody?: boolean; publicationConsent?: boolean } = {},
) {
  const plan = structuredClone(input);
  if (
    plan?.schema !== "pirate.linux-web2-schema/1" ||
    Object.keys(plan).sort().join(",") !== "overlays,schema" ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(releaseSha256) ||
    !Array.isArray(plan.overlays) ||
    plan.overlays.length !== names.length
  )
    throw Error("web2_schema_plan_invalid");
  for (const [i, row] of plan.overlays.entries()) {
    if (
      Object.keys(row).sort().join(",") !== "name,sha256,sql,statements" ||
      row.name !== names[i] ||
      typeof row.sql !== "string" ||
      row.sql.length > 256 * 1024 ||
      !Array.isArray(row.statements) ||
      !row.statements.length ||
      !row.statements.every((s) => typeof s === "string" && s.trim()) ||
      row.statements.join("") !== row.sql ||
      row.sha256 !== (await digest(row.sql))
    )
      throw Error("web2_schema_source_changed");
  }
  const posts = options.postsCustody ? LOCAL_POSTS_CUSTODY_SCHEMA : [];
  const publicationConsent = options.publicationConsent === true;
  // Both context slots follow their overlay's attested metadata INSERT, in
  // the same atomic D1 batch. Direct overlay execution keeps both defaults.
  const nativeGuard = plan.overlays[2]?.statements[3];
  if (publicationConsent && plan.overlays[0]?.statements[2]?.trim() !== defaultCatalogConsentContext)
    throw Error("web2_catalog_consent_context_changed");
  if (publicationConsent && nativeGuard?.split(defaultNativeConsentContext).length !== 2)
    throw Error("web2_native_consent_context_changed");
  const selected = options.postsCustody || publicationConsent ? {
    plan,
    ...(options.postsCustody ? { postsCustody: posts } : {}),
    ...(publicationConsent ? { publicationConsent: true } : {}),
  } : plan;
  const manifestSha256 = await digest(JSON.stringify(selected));
  const existing = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE lower(name)='_pirate_web2_schema'",
    )
    .first();
  if (existing) {
    // Source/release and the COMPLETE executable/table/index schema must still
    // match the atomically retained postimage. No reapplication or data copying.
    await db.batch([
      db.prepare(guard),
      db
        .prepare(
          `INSERT INTO _pirate_web2_transition_guard SELECT CASE WHEN
        (SELECT count(*) FROM _pirate_web2_schema)=1 AND EXISTS(
          SELECT 1 FROM _pirate_web2_schema WHERE singleton=1 AND manifest_sha256=? AND release_sha256=?
          AND schema_json=${schemaDocument}) THEN 1 ELSE 0 END`,
        )
        .bind(manifestSha256, releaseSha256),
      db.prepare("DROP TABLE _pirate_web2_transition_guard"),
    ]);
    return { manifestSha256, alreadyInitialized: true };
  }
  await db.batch([
    db.prepare(
      "CREATE TABLE _pirate_web2_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),manifest_sha256 TEXT NOT NULL,release_sha256 TEXT NOT NULL,schema_json TEXT NOT NULL)",
    ),
    ...plan.overlays.flatMap((row, overlay) =>
      row.statements.map((sql, statement) => {
        if (publicationConsent && overlay === 0 && statement === 2)
          return db.prepare(catalogConsentContext + "? WHERE singleton=1").bind(1);
        if (publicationConsent && overlay === 2 && statement === 3)
          return db.prepare(sql.replace(defaultNativeConsentContext, boundNativeConsentContext)).bind(1);
        return db.prepare(sql);
      }),
    ),
    ...posts.map((sql) => db.prepare(sql)),
    db.prepare(guard),
    db.prepare(
      "INSERT INTO _pirate_web2_transition_guard SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END",
    ),
    db
      .prepare(
        `INSERT INTO _pirate_web2_schema VALUES(1,?,?,${schemaDocument})`,
      )
      .bind(manifestSha256, releaseSha256),
    db.prepare("DROP TABLE _pirate_web2_transition_guard"),
  ]);
  return { manifestSha256, alreadyInitialized: false };
}
