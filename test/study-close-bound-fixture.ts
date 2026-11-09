// Shared helpers for lessons with a legacy deadline and for the close bound of
// lessons without one. Legacy rows are only ever created here, before binding.
import assert from "node:assert/strict";
import {
  STUDY_LESSON_LIFETIME_MS,
  STUDY_LESSON_NO_DEADLINE,
  studyCloseBound,
  type LessonState,
} from "../packages/study/lesson.ts";

/** Give an open, unbound lesson the one-hour deadline used before 2026-11-08. */
export async function makeLegacyLesson(db: D1Database, lessonId: string) {
  const result = await db
    .prepare(
      `UPDATE study_lessons SET state_json=json_set(state_json,'$.expiresAt',
        json_extract(state_json,'$.startedAt')+?)
      WHERE lesson_id=? AND json_extract(state_json,'$.status')='active'
        AND json_extract(state_json,'$.expiresAt')=?`,
    )
    .bind(STUDY_LESSON_LIFETIME_MS, lessonId, STUDY_LESSON_NO_DEADLINE)
    .run();
  assert.equal(result.meta.changes, 1, "legacy conversion needs a new lesson");
}

export async function lessonState(db: D1Database, lessonId: string) {
  const row = await db
    .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
    .bind(lessonId)
    .first<{ state_json: string }>();
  assert.ok(row);
  return JSON.parse(row.state_json) as LessonState;
}

/** The bound consent's end in seconds, or null if no binding row exists. */
export async function boundConsentExpiry(db: D1Database, lessonId: string) {
  const row = await db
    .prepare(
      "SELECT json_extract(binding_json,'$.enrollment.expiresAt') AS e FROM study_publications WHERE lesson_id=?",
    )
    .bind(lessonId)
    .first<{ e: number }>()
    .catch(() => null);
  return row ? Number(row.e) : null;
}

/** The instant an open lesson closes, computed independently of the service. */
export async function closeBoundOf(db: D1Database, lessonId: string) {
  return studyCloseBound(
    await lessonState(db, lessonId),
    await boundConsentExpiry(db, lessonId),
  );
}

interface RouteFixture {
  env: { KARAOKE_OPERATOR?: Fetcher };
  db: D1Database;
  post(
    path: string,
    body: unknown,
    auth?: Record<string, string>,
  ): Promise<Response>;
  call(path: string, init?: RequestInit): Promise<Response>;
}
/**
 * Start a lesson through the real routes as it was started before the time
 * limit was removed. The first bind is refused so the draft stays unbound
 * while it gains its one-hour deadline; the normal open-attempt route then
 * binds that legacy offer. Returns the bound lesson with an open first card.
 */
export async function startLegacyThroughRoutes(
  f: RouteFixture,
  auth: Record<string, string>,
  song: unknown,
) {
  const original = f.env.KARAOKE_OPERATOR!,
    requestId = crypto.randomUUID();
  f.env.KARAOKE_OPERATOR = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/study/bind")
        throw Error("fixture: hold bind for legacy conversion");
      return original.fetch(request);
    },
  } as Fetcher;
  try {
    const refused = await f.post(
      "/api/study/lessons",
      { requestId, song },
      auth,
    );
    assert.notEqual(refused.status, 200);
  } finally {
    f.env.KARAOKE_OPERATOR = original;
  }
  const row = await f.db
    .prepare("SELECT lesson_id FROM study_lessons WHERE request_id=?")
    .bind(requestId)
    .first<{ lesson_id: string }>();
  assert.ok(row);
  await makeLegacyLesson(f.db, row.lesson_id);
  const path = "/api/study/lessons/" + row.lesson_id;
  const opened = await f.post(
    path + "/attempts",
    { presentationNumber: 1, takeNumber: 1 },
    auth,
  );
  assert.equal(opened.status, 200, await opened.clone().text());
  const lesson = await f.call(path, { headers: auth });
  assert.equal(lesson.status, 200);
  return lesson.json() as Promise<
    import("../packages/study/lesson.ts").StudyLesson
  >;
}
