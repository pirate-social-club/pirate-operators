import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Effect } from "effect";
import { makeStudyService, readStudyAudio } from "../services/study-spoken.ts";
import { selectionOf, type StudyLine } from "../packages/study/contracts.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";

const line: StudyLine = {
  chainId: 6343,
  postsContract: `0x${"2".repeat(40)}`,
  communityId: `0x${"a".repeat(64)}`,
  postId: `0x${"b".repeat(64)}`,
  lineId: `0x${"c".repeat(64)}`,
  lyricRevision: 1,
  lineVersion: 1,
  text: "Hold me close",
  language: "en",
  manifestDigest: `0x${"d".repeat(64)}`,
};
const owner = { accountId: "local-learner", communityId: line.communityId };
const other = { ...owner, accountId: "other-learner" };
const recording = (suffix = 1) =>
  new Request("https://study.example/audio", {
    method: "PUT",
    headers: {
      "content-type": "audio/webm;codecs=opus",
      "x-study-duration-ms": "1000",
    },
    body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, suffix]),
  });
async function runtime(persist?: string) {
  const mf = new Miniflare({
    modules: true,
    script:
      "export default {fetch(){return new Response('local Study fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: { DB: "study-fixture" },
    ...(persist ? { d1Persist: persist } : {}),
  });
  const db = await mf.getD1Database("DB");
  return { db, dispose: () => mf.dispose() };
}
async function fixture(
  transcribe: StudyTranscriber["transcribe"] = async () => ({
    text: line.text,
    language: "en",
  }),
) {
  const f = await runtime();
  const sql = await readFile(
    new URL("../packages/study/schema.sql", import.meta.url),
    "utf8",
  );
  await f.db.batch(
    sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim())
      .map((s) => f.db.prepare(s)),
  );
  let calls = 0;
  const options = {
    db: f.db,
    transcriber: {
      providerRetention: "stored" as const,
      transcribe: async (
        ...args: Parameters<StudyTranscriber["transcribe"]>
      ) => {
        calls++;
        return transcribe(...args);
      },
    },
    resolveLine: async () => line,
    now: () => 1793894400000,
  };
  return {
    ...f,
    options,
    service: makeStudyService(options),
    calls: () => calls,
  };
}
test("server-selected untimed line, failed result and retry remain separate persisted attempts", async () => {
  let text = "unrelated words";
  const f = await fixture(async () => ({ text, language: "en" }));
  try {
    const a = await f.service.open(
      owner,
      "first-recording-id",
      selectionOf(line),
    );
    const failed = await Effect.runPromise(
      f.service.submit(owner, a.attemptId, recording()),
    );
    assert.equal(failed.state, "assessed");
    assert.equal(failed.grade?.correct, false);
    assert.equal(failed.qualification, "not_evaluated");
    text = line.text;
    const b = await f.service.open(
      owner,
      "retry-recording-id",
      selectionOf(line),
    );
    const passed = await Effect.runPromise(
      f.service.submit(owner, b.attemptId, recording()),
    );
    assert.equal(passed.grade?.correct, true);
    assert.notEqual(a.attemptId, b.attemptId);
    const restored = makeStudyService(f.options);
    assert.deepEqual(await restored.get(owner, b.attemptId), passed);
    assert.equal(
      (await restored.get(owner, a.attemptId)).grade?.correct,
      false,
    );
    assert.equal((await restored.list(owner)).length, 2);
    assert.equal(f.calls(), 2);
  } finally {
    await f.dispose();
  }
});
test("parallel replays and lost responses dispatch the provider once; changed audio conflicts", async () => {
  const f = await fixture();
  try {
    const opens = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.service.open(owner, "stable-recording-id", selectionOf(line)),
      ),
    );
    assert.equal(new Set(opens.map((a) => a.attemptId)).size, 1);
    const id = opens[0].attemptId;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        Effect.runPromise(f.service.submit(owner, id, recording())),
      ),
    );
    assert.equal(f.calls(), 1);
    assert.equal(
      (await Effect.runPromise(f.service.submit(owner, id, recording()))).grade
        ?.correct,
      true,
    );
    await assert.rejects(
      Effect.runPromise(f.service.submit(owner, id, recording(2))),
      /study_audio_conflict/,
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});
test("accounts and communities cannot read, submit or change one another's reference", async () => {
  const f = await fixture();
  try {
    const a = await f.service.open(
      owner,
      "private-recording-id",
      selectionOf(line),
    );
    await assert.rejects(
      f.service.get(other, a.attemptId),
      /study_attempt_not_found/,
    );
    await assert.rejects(
      Effect.runPromise(f.service.submit(other, a.attemptId, recording())),
      /study_attempt_not_found/,
    );
    assert.deepEqual(await f.service.list(other), []);
    await assert.rejects(
      f.service.open(
        { ...owner, communityId: `0x${"e".repeat(64)}` },
        "wrong-community-id",
        selectionOf(line),
      ),
      /study_wrong_community/,
    );
    await assert.rejects(
      f.service.open(owner, "injected-reference-id", {
        ...selectionOf(line),
        text: "attacker text",
      }),
      /invalid_study_selection/,
    );
    await assert.rejects(
      f.service.open(owner, "private-recording-id", {
        ...selectionOf(line),
        lineId: `0x${"f".repeat(64)}`,
      }),
      /study_reference_mismatch/,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
});
test("unknown and refused provider outcomes never become grades or automatically redispatch", async () => {
  for (const outcome of ["known_failed", "unknown"] as const) {
    const f = await fixture(async () => {
      throw new StudySpeechError("speech_unavailable", outcome);
    });
    try {
      const a = await f.service.open(
        owner,
        "provider-failure-id",
        selectionOf(line),
      );
      const result = await Effect.runPromise(
        f.service.submit(owner, a.attemptId, recording()),
      );
      assert.equal(
        result.state,
        outcome === "known_failed" ? "unavailable" : "uncertain",
      );
      assert.equal(result.grade, null);
      await Effect.runPromise(
        f.service.submit(owner, a.attemptId, recording()),
      );
      assert.equal(f.calls(), 1);
    } finally {
      await f.dispose();
    }
  }
});
test("interrupted assessment remains pending after runtime restart without a second provider dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-persist-"));
  let f = await runtime(dir);
  try {
    const sql = await readFile(
      new URL("../packages/study/schema.sql", import.meta.url),
      "utf8",
    );
    await f.db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim())
        .map((s) => f.db.prepare(s)),
    );
    const options = {
      db: f.db,
      resolveLine: async () => line,
      transcriber: {
        providerRetention: "stored" as const,
        transcribe: async () => ({ text: line.text, language: "en" }),
      },
    };
    const a = await makeStudyService(options).open(
      owner,
      "crashed-recording-id",
      selectionOf(line),
    );
    const { sha256 } = await import("viem");
    const { audio } = await readStudyAudio(recording());
    await f.db
      .prepare(
        "UPDATE study_attempts SET state='assessing',audio_digest=?,audio_duration_ms=1000 WHERE attempt_id=?",
      )
      .bind(sha256(audio), a.attemptId)
      .run();
    await f.dispose();
    f = await runtime(dir);
    let calls = 0;
    const resumed = makeStudyService({
      ...options,
      db: f.db,
      transcriber: {
        providerRetention: "stored",
        transcribe: async () => {
          calls++;
          return { text: line.text, language: "en" };
        },
      },
    });
    assert.equal((await resumed.get(owner, a.attemptId)).state, "assessing");
    await Effect.runPromise(resumed.submit(owner, a.attemptId, recording()));
    assert.equal(calls, 0);
  } finally {
    await f.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("audio streams enforce actual byte bounds and container type before paid dispatch", async () => {
  await assert.rejects(
    readStudyAudio(
      new Request("https://study.example", {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "x-study-duration-ms": "1000",
        },
        body: "plain text is not audio",
      }),
    ),
    /invalid_study_audio/,
  );
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(2097153));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readStudyAudio(
      new Request("https://study.example", {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "x-study-duration-ms": "1000",
        },
        body,
        duplex: "half",
      } as RequestInit),
    ),
    /study_audio_too_large/,
  );
  assert.equal(cancelled, true);
});
test("daily admission bound is atomic while retained request replay remains available", async () => {
  const f = await fixture();
  try {
    const first = await f.service.open(
      owner,
      "retained-request-id",
      selectionOf(line),
    );
    await f.db.batch(
      Array.from({ length: 99 }, (_, i) =>
        f.db
          .prepare(
            `INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,started_at,policy,state)
      VALUES(?,?,?,?,?,?,'script_aware_token_phonetic_v4','ready')`,
          )
          .bind(
            `quota-${i}`,
            owner.accountId,
            owner.communityId,
            `quota-request-${i}`,
            JSON.stringify(line),
            f.options.now(),
          ),
      ),
    );
    await assert.rejects(
      f.service.open(owner, "new-request-at-limit", selectionOf(line)),
      /study_daily_limit/,
    );
    assert.equal(
      (await f.service.open(owner, "retained-request-id", selectionOf(line)))
        .attemptId,
      first.attemptId,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
});
test("newer attempts on other lines cannot hide a retained line result", async () => {
  const f = await fixture();
  try {
    const first = await f.service.open(
      owner,
      "retained-line-result",
      selectionOf(line),
    );
    await Effect.runPromise(
      f.service.submit(owner, first.attemptId, recording()),
    );
    const otherLine = { ...line, lineId: `0x${"e".repeat(64)}` };
    await f.db.batch(
      Array.from({ length: 60 }, (_, i) =>
        f.db
          .prepare(
            `INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,started_at,policy,state)
      VALUES(?,?,?,?,?,?,'script_aware_token_phonetic_v4','ready')`,
          )
          .bind(
            `history-${i}`,
            owner.accountId,
            owner.communityId,
            `history-request-${i}`,
            JSON.stringify(otherLine),
            f.options.now() + 1,
          ),
      ),
    );
    assert.equal(
      (await f.service.list(owner)).some(
        (row) => row.attemptId === first.attemptId,
      ),
      false,
    );
    const retained = await f.service.list(owner, selectionOf(line));
    assert.equal(retained.length, 1);
    assert.equal(retained[0].grade?.correct, true);
  } finally {
    await f.dispose();
  }
});
