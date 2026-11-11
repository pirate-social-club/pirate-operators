import { telegramCheck } from "../packages/telegram/contracts.ts";
import { telegramGrade } from "../packages/telegram/grading.ts";

const writesGrade = (sql: string) =>
  /\b(?:UPDATE\s+study_attempts|(?:INSERT\s+INTO|REPLACE\s+INTO)\s+study_attempts)\b/i.test(
    sql,
  ) && /\bgrade_json\b/i.test(sql);
const finishesAttempt =
  /^\s*UPDATE\s+study_attempts\s+SET\s+state\s*=\s*\?\s*,\s*grade_json\s*=\s*\?\s*,\s*failure\s*=\s*\?/i;

/** The connected Study factory uses this binding for the existing attempt
 * store. The reviewed lane5 finish statement binds the grade second. */
export function telegramLinkedDatabase(db: D1Database): D1Database {
  function wrap<T extends D1Database | D1DatabaseSession>(target: T): T {
    return new Proxy(target, {
      get(source, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (!writesGrade(sql)) return source.prepare(sql);
            telegramCheck(
              finishesAttempt.test(sql),
              "telegram_grade_statement_unsupported",
              503,
            );
            const statement = source.prepare(sql);
            return new Proxy(statement, {
              get(prepared, field) {
                if (field === "bind")
                  return (state: unknown, raw: unknown, ...rest: unknown[]) => {
                    const grade =
                      typeof raw === "string"
                        ? telegramGrade(JSON.parse(raw))
                        : null;
                    telegramCheck(
                      raw === null || grade,
                      "telegram_grade_invalid",
                      503,
                    );
                    return prepared.bind(
                      state,
                      grade === null ? null : JSON.stringify(grade),
                      ...rest,
                    );
                  };
                const value = Reflect.get(prepared, field);
                return typeof value === "function"
                  ? value.bind(prepared)
                  : value;
              },
            });
          };
        if (key === "withSession" && "withSession" in source)
          return (...args: Parameters<D1Database["withSession"]>) =>
            wrap(source.withSession(...args));
        if (key === "exec" && "exec" in source)
          return (sql: string) => {
            telegramCheck(
              !writesGrade(sql),
              "telegram_grade_statement_unsupported",
              503,
            );
            return source.exec(sql);
          };
        const value = Reflect.get(source, key);
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
  }
  return wrap(db);
}

/** Scrub completed legacy writes only within an authorized Telegram lesson.
 * An assessed attempt's grade is immutable except for this reduction. */
export async function scrubLinkedGrades(
  db: D1Database,
  lesson: string,
  account: string,
  community: string,
) {
  const { results } = await db
    .prepare(
      `SELECT attempt_id,grade_json FROM study_attempts
     WHERE lesson_id=? AND account_id=? AND community_id=? AND state='assessed'
       AND EXISTS (SELECT 1 FROM json_each(grade_json)
         WHERE key NOT IN ('correct','matchKind','policyRevision','rerecordReason'))
     ORDER BY attempt_id LIMIT 50`,
    )
    .bind(lesson, account, community)
    .all<{ attempt_id: string; grade_json: string }>();
  const updates = results.flatMap((row) => {
    const grade = telegramGrade(JSON.parse(row.grade_json));
    return grade
      ? [
          db
            .prepare(
              `UPDATE study_attempts SET grade_json=? WHERE attempt_id=? AND lesson_id=?
       AND account_id=? AND community_id=? AND state='assessed'`,
            )
            .bind(
              JSON.stringify(grade),
              row.attempt_id,
              lesson,
              account,
              community,
            ),
        ]
      : [];
  });
  if (updates.length) await db.batch(updates);
}
