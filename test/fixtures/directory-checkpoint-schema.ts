import { readFile } from "node:fs/promises";
export async function prepareDirectoryCache(db: D1Database) {
  // Proposed additive schema installed only in this disposable test database.
  const sql = await readFile(new URL("../../docs/contracts/directory-checkpoint-cache.sql", import.meta.url), "utf8");
  const statements = sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}
