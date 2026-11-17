// Normal communityFetch and its default dependencies, actual Web2 Directory and
// Posts local chain, D1 lessons/history and issuer-authorized operator route.
// ACR/IPFS and ASR outputs are explicit offline fixtures; no provider spending.
// Failures first: first-song activation by old bindings, wrong/missing runtime,
// public-grant substitution, changed selection, missing CSRF, cross-account
// history, and private practice acquiring a publication or sponsorship intent.
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { web2FirstSongFixture } from "./fixtures/web2-first-song.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { studyOperatorRoute } from "../services/study-operator.ts";
import type { Env } from "../services/runtime.ts";
import type { StudyPrivateV5Env } from "../services/study-v5-profile.ts";
import type {
  StudySong,
  StudyLesson,
  StudyLessonSubmission,
} from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";

async function ok<T>(response: Response): Promise<T> {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
test(
  "ordinary Web2 login, song, private Study, assessment and history join without public consent or payment",
  { timeout: 120000 },
  async (t) => {
    const f = await web2FirstSongFixture({
      lyrics:
        "We sail away\nThe tide is high\nWe sing tonight\nThe stars are bright\nWe find our way\nWe greet the day",
    });
    t.after(f.close);
    const app = f.application,
      config = app.configuration(),
      budget = speechRepairFixture({ communityId: config.communityId });
    t.after(budget.close);
    budget.advance(Math.floor(Date.now() / 1000) - budget.store.now());
    const profile = {
      schema: "pirate.study-private-runtime/5",
      version: 5,
      chainId: 6343,
      communityId: config.communityId,
      sourceChainId: 6343,
      contract: config.postsContract,
      releaseHash: hashText(
        "offline private runtime identity; not a public V5 contract",
      ),
      speechPolicyHash: hashJson(budget.policy),
    };
    const operatorEnv = {
      ...budget.env,
      PAYMENT_CHAIN_ID: "6343",
      COMMUNITY_ID: config.communityId,
      OPERATOR_ADDRESS: accounts[2].address,
      ISSUER: accounts[1].address,
      STUDY_PRIVATE_V5_PROFILE: JSON.stringify(profile),
    } as Env & StudyPrivateV5Env;
    let heard = "",
      speechCalls = 0;
    const provider = {
      providerRetention: "stored" as const,
      async transcribe() {
        speechCalls++;
        return { text: heard, language: "en" };
      },
    };
    Object.assign(app.env, budget.env, {
      STUDY_RUNTIME: "private-v5",
      STUDY_PRIVATE_V5_PROFILE: JSON.stringify(profile),
      KARAOKE_SERVICE_MODE: "internal",
      KARAOKE_OPERATOR_ADDRESS: accounts[2].address,
      KARAOKE_SIGNER_PRIVATE_KEY: keys[1],
      KARAOKE_PAYMENT_CHAIN_ID: "6343",
      KARAOKE_OPERATOR: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          // This normal app uses wall-clock issuer requests; keep the explicit
          // fixture operator/budget clock current across first-song publication.
          budget.advance(Math.floor(Date.now() / 1000) - budget.store.now());
          return (
            (await studyOperatorRoute(
              new Request(input, init),
              operatorEnv,
              budget.store,
              provider,
            )) ?? new Response("not_found", { status: 404 })
          );
        },
      },
    });
    // Service bindings alone leave the first-song release unchanged.
    assert.equal((await app.fetch("/api/study/song")).status, 404);
    const originalDeployment = app.env.COMMUNITY_DEPLOYMENT_PROFILE_JSON,
      originalAttachment = app.env.WEB2_PUBLISHING_ATTACHMENT_JSON;
    const selected = {
      schema: "pirate.community-private-practice/1",
      communityId: config.communityId,
      installationId: app.deployment.directoryProfile.installationId,
      deploymentDigest: hashJson(app.deployment),
      activities: {
        study: { kind: "private-v5", profileHash: hashJson(profile) },
        karaoke: null,
        dance: null,
      },
    };
    app.env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON = JSON.stringify(selected);
    const caps = await ok<{ study: boolean; studyRuntime?: string }>(
      await app.fetch("/api/capabilities"),
    );
    assert.equal(caps.study, true);
    assert.equal(caps.studyRuntime, "private-v5");
    const owner = await f.login(),
      other = await f.login("other");
    assert.equal(owner.challenge.kind, undefined);
    const published = await f.publish(owner);
    assert.equal(published.job.phase, "published");
    const view = await ok<{ posts: { manifest: { postId: string } }[] }>(
      await app.fetch("/api/feed"),
    );
    const postId = view.posts[0]!.manifest.postId;
    const get = (path: string) =>
      app.fetch(path, {
        headers: {
          cookie: owner.cookie,
          "x-study-account": owner.session.mossAddress,
        },
      });
    const post = (path: string, body: unknown) =>
      owner.write(path, "POST", JSON.stringify(body), {
        "content-type": "application/json",
        "x-study-account": owner.session.mossAddress,
      });
    const song = await ok<StudySong>(
        await get("/api/study/song?postId=" + postId),
      ),
      requestId = crypto.randomUUID();
    assert.equal(
      (
        await post("/api/study/lessons", {
          requestId,
          song,
          publication: { kind: "publication-bound" },
        })
      ).status,
      409,
    );
    let lesson = await ok<StudyLesson>(
      await post("/api/study/lessons", {
        requestId,
        song,
        publication: { kind: "private" },
      }),
    );
    const id = lesson.lessonId,
      base = "/api/study/lessons/" + id;
    assert.equal(
      (
        await ok<StudyLesson>(
          await post("/api/study/lessons", {
            requestId,
            song,
            publication: { kind: "private" },
          }),
        )
      ).lessonId,
      id,
    );
    assert.equal(
      (
        await app.fetch(base, {
          headers: {
            cookie: other.cookie,
            "x-study-account": other.session.mossAddress,
          },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(base + "/attempts", {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            origin: app.deployment.origin,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    while (lesson.current) {
      const opened = await ok<{ attempt: StudyAttempt; lesson: StudyLesson }>(
        await post(base + "/attempts", {
          presentationNumber: lesson.current.presentationNumber,
          takeNumber: lesson.current.takeNumber,
        }),
      );
      heard = opened.attempt.line.text;
      const audio = new Uint8Array(40000);
      audio.set([0x1a, 0x45, 0xdf, 0xa3]);
      const result = await ok<StudyLessonSubmission>(
        await owner.write(
          base + "/attempts/" + opened.attempt.attemptId + "/audio",
          "PUT",
          audio,
          {
            "x-study-account": owner.session.mossAddress,
            "content-type": "audio/webm",
            "x-study-duration-ms": "1000",
          },
        ),
      );
      assert.equal(result.attempt.state, "assessed");
      lesson = result.lesson;
    }
    assert.equal(lesson.status, "completed");
    assert.equal(speechCalls, lesson.progress.total);
    assert.deepEqual(await ok(await post(base + "/publication", {})), {
      state: "private",
      receipt: null,
    });
    const history = await ok<{
      exportedAt: number;
      lesson: { state: { privateV5: { publication: { kind: string } } } };
      attempts: StudyAttempt[];
    }>(await post(base + "/history", {}));
    assert.equal(history.lesson.state.privateV5.publication.kind, "private");
    assert.equal(history.attempts.length, speechCalls);
    assert.equal(budget.store.entries("intent:").length, 0);
    assert.equal(budget.store.entries("sponsor:").length, 0);
    assert.equal(budget.store.entries("studyPublication:").length, 0);
    assert.equal(
      await app.db
        .prepare("SELECT count(*) n FROM study_publications")
        .first("n"),
      0,
    );
    assert.equal(app.env.COMMUNITY_DEPLOYMENT_PROFILE_JSON, originalDeployment);
    assert.equal(app.env.WEB2_PUBLISHING_ATTACHMENT_JSON, originalAttachment);
    for (const path of [
      "/api/karaoke/tickets",
      "/api/learning/public-results/on",
      "/api/dance/rooms",
      "/api/rewards",
      "/api/member-name",
    ])
      assert.equal((await app.fetch(path)).status, 404, path);
    for (const activity of ["karaoke", "dance"] as const) {
      app.env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON = JSON.stringify({
        ...selected,
        activities: {
          ...selected.activities,
          [activity]:
            activity === "karaoke"
              ? { kind: "private-v5", profileHash: hashJson(profile) }
              : {
                  kind: "private-v2",
                  policyHash: hashText("selected but not installed"),
                },
        },
      });
      assert.equal(
        (
          await app.fetch(
            activity === "karaoke"
              ? "/api/karaoke/enrollment"
              : "/api/dance/rooms",
          )
        ).status,
        503,
      );
    }
    app.env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON = JSON.stringify({
      ...selected,
      activities: {
        ...selected.activities,
        study: { kind: "private-v5", profileHash: hashText("wrong runtime") },
      },
    });
    assert.equal((await get(base)).status, 503);
    app.env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON = JSON.stringify(selected);
    const binding = app.env.KARAOKE_OPERATOR;
    app.env.KARAOKE_OPERATOR = undefined;
    assert.equal((await get(base)).status, 503);
    app.env.KARAOKE_OPERATOR = binding;
    assert.equal((await ok<StudyLesson>(await get(base))).lessonId, id);
    // Saved private export uses account/CSRF/D1 authority, even when the
    // separate speech/operator runtime is unavailable. Public permission does
    // not become necessary to read already saved private work.
    const speechBudget = app.env.SPEECH_BUDGET;
    app.env.KARAOKE_OPERATOR = undefined;
    app.env.SPEECH_BUDGET = undefined;
    const offlineHistory = await ok<typeof history>(
      await post(base + "/history", {}),
    );
    assert.ok(
      offlineHistory.exportedAt >= history.exportedAt &&
        offlineHistory.exportedAt <= Date.now(),
    );
    assert.deepEqual(
      { ...offlineHistory, exportedAt: history.exportedAt },
      history,
    );
    assert.equal(
      (
        await other.write(base + "/history", "POST", "{}", {
          "content-type": "application/json",
          "x-study-account": other.session.mossAddress,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(base + "/history", {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            origin: app.deployment.origin,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (await get(base)).status,
      503,
      "new practice still requires the selected runtime",
    );
    app.env.KARAOKE_OPERATOR = binding;
    app.env.SPEECH_BUDGET = speechBudget;
    // An unrelated Directory title/revision change does not create a public
    // permission requirement for private work over the captured canonical song.
    // Preserve exact source/mode and no paid/public effect across the await.
    const db = app.env.DB,
      sql =
        "SELECT * FROM study_lessons WHERE account_id=? AND community_id=? AND request_id=?";
    let changed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (key === "first")
            return async () => {
              const row = await target.first();
              if (!changed) {
                changed = true;
                await f.configureNextRevision();
              }
              return row;
            };
          const member = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    app.env.DB = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (query: string) =>
            query === sql ? wrap(target.prepare(query)) : target.prepare(query);
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const beforeLessons = await db
        .prepare("SELECT count(*) n FROM study_lessons")
        .first("n"),
      beforeBindings = budget.store.entries("studyV5PrivateBinding:").length;
    const raced = await post("/api/study/lessons", {
      requestId: crypto.randomUUID(),
      song,
      publication: { kind: "private" },
    });
    assert.equal(
      changed,
      true,
      "actual Directory change occurred inside the request",
    );
    assert.equal(raced.status, 200, await raced.clone().text());
    const privateContinuation = (await raced.json()) as StudyLesson;
    assert.deepEqual(privateContinuation.song, song);
    assert.equal(
      await db.prepare("SELECT count(*) n FROM study_lessons").first("n"),
      Number(beforeLessons) + 1,
    );
    assert.equal(
      budget.store.entries("studyV5PrivateBinding:").length,
      beforeBindings + 1,
    );
    assert.equal(speechCalls, lesson.progress.total);
    const originalPrivate = await db
      .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
      .bind(privateContinuation.lessonId)
      .first<{ state_json: string }>();
    assert.equal(
      JSON.parse(originalPrivate!.state_json).privateV5.publication.kind,
      "private",
    );
    assert.equal(budget.store.entries("intent:").length, 0);
    assert.equal(budget.store.entries("sponsor:").length, 0);
    assert.equal(budget.store.entries("studyPublication:").length, 0);
    const artifact = {
      schema: "pirate.web2-private-study-acceptance/1",
      scope:
        "actual default app/Directory/Posts/D1/issuer/assessment; provider outputs simulated",
      communityId: config.communityId,
      postId,
      song,
      lessonId: id,
      status: lesson.status,
      graded: lesson.progress.firstPassCorrect,
      speechCalls,
      profileHash: hashJson(profile),
      historyPrivate: history.lesson.state.privateV5.publication.kind,
      offlineHistoryExport: true,
      unselectedActivities: "404",
      selectedUnjoinedActivities: "503",
      publicIntents: 0,
      preservedDeployment:
        app.env.COMMUNITY_DEPLOYMENT_PROFILE_JSON === originalDeployment,
      continuedPrivateLesson: privateContinuation.lessonId,
      continuedPrivateMode: JSON.parse(originalPrivate!.state_json).privateV5
        .publication.kind,
    };
    await mkdir(".local/web2-private-study-normal", { recursive: true });
    await writeFile(
      ".local/web2-private-study-normal/acceptance-" + Date.now() + ".json",
      JSON.stringify(artifact, null, 2) + "\n",
    );
    app.env.DB = db;
  },
);
