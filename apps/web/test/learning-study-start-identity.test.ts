// Unrun pure client regression. No server, provider, browser, chain or key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStudyClient } from "../src/study/client.ts";
import type { StudyLesson, StudySong } from "../../../packages/study/lesson.ts";

test("an explicit retry after unknown Study start reuses the complete request identity", async () => {
  const original = globalThis.fetch;
  const song: StudySong = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: `0x${"2".repeat(64)}`,
    postId: `0x${"3".repeat(64)}`,
    lyricRevision: 1,
  };
  const value: StudyLesson = {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: `0x${"4".repeat(64)}`,
    song,
    startedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: 2,
    status: "completed",
    completionReason: "all_resolved",
    current: null,
    lastAttempt: null,
    progress: {
      total: 4,
      resolved: 4,
      mastered: 4,
      presentations: 4,
      presentationCap: 12,
      firstPassGraded: 4,
      firstPassCorrect: 4,
    },
    qualification: "not_evaluated",
  };
  const bodies: string[] = [];
  globalThis.fetch = (async (path, init) => {
    assert.equal(path, "/api/study/lessons");
    assert.equal(init?.method, "POST");
    bodies.push(String(init.body));
    if (bodies.length === 1) throw new Error("response lost after dispatch");
    return Response.json(value);
  }) as typeof fetch;
  try {
    const client = createStudyClient(
      song,
      () => "fixture-csrf",
      undefined,
      undefined,
      undefined,
      () => true,
      "fixture-account",
    );
    await assert.rejects(client.restart(), /response lost/);
    assert.equal((await client.restart()).lessonId, value.lessonId);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a stale account mount cannot expose a lesson opened by a late response", async () => {
  const original = globalThis.fetch;
  let resolve!: (response: Response) => void,
    active = true,
    remembered = false;
  globalThis.fetch = (() =>
    new Promise<Response>((done) => {
      resolve = done;
    })) as typeof fetch;
  const song: StudySong = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: `0x${"2".repeat(64)}`,
    postId: `0x${"3".repeat(64)}`,
    lyricRevision: 1,
  };
  try {
    const client = createStudyClient(
      song,
      () => "fixture-csrf",
      "lesson",
      () => {
        remembered = true;
      },
      undefined,
      () => active,
      "fixture-account",
    );
    const pending = client.refresh();
    active = false;
    resolve(
      Response.json({
        schema: "pirate.study.lesson/1",
        kind: "say-it-back",
        song,
        lessonId: "lesson",
      }),
    );
    await assert.rejects(pending, /closed/);
    assert.equal(remembered, false);
  } finally {
    globalThis.fetch = original;
  }
});
