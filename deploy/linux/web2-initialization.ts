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
  const manifestSha256 = await digest(JSON.stringify(plan));
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
    ...plan.overlays.flatMap((row) =>
      row.statements.map((sql) => db.prepare(sql)),
    ),
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
