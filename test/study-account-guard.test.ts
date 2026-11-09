import test from "node:test";
import assert from "node:assert/strict";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { accounts } from "../harness/runtime.ts";
import type { StudyLesson, StudySong } from "../packages/study/lesson.ts";

// A page names the account whose lessons it shows. When the session cookie
// belongs to another account, every Study route refuses instead of returning
// or changing the other account's lessons.
test(
  "Study routes refuse a page that expects another account and never mix two accounts' lessons",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19932);
    try {
      const first = await f.login(5),
        second = await f.login(6);
      await f.enroll(5);
      const song = (await (
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: first,
        })
      ).json()) as StudySong;
      const lesson = (await (
        await f.post(
          "/api/study/lessons",
          { song, requestId: crypto.randomUUID() },
          { ...first, "x-study-account": accounts[5].address },
        )
      ).json()) as StudyLesson;
      const path = "/api/study/lessons/" + lesson.lessonId;
      // The matching account, in any letter case, is accepted.
      const own = await f.call(path, {
        headers: {
          ...first,
          "x-study-account": accounts[5].address.toLowerCase(),
        },
      });
      assert.equal(own.status, 200, await own.clone().text());
      // The second account's cookie with a page that still expects the first.
      for (const request of [
        () =>
          f.call(path, {
            headers: { ...second, "x-study-account": accounts[5].address },
          }),
        () =>
          f.call(
            "/api/study/lessons?song=" + encodeURIComponent(JSON.stringify(song)),
            { headers: { ...second, "x-study-account": accounts[5].address } },
          ),
        () =>
          f.post(path + "/abandon", {}, {
            ...second,
            "x-study-account": accounts[5].address,
          }),
        () =>
          f.post(path + "/attempts", { presentationNumber: 1, takeNumber: 1 }, {
            ...second,
            "x-study-account": accounts[5].address,
          }),
        // A stale page: the new account's cookie with the old page's CSRF
        // token. The account refusal comes first, so the page can clear.
        () =>
          f.post(path + "/abandon", {}, {
            cookie: second.cookie,
            "x-csrf-token": first["x-csrf-token"],
            "x-study-account": accounts[5].address,
          }),
      ]) {
        const response = await request();
        assert.equal(response.status, 409);
        assert.equal(
          ((await response.json()) as { error: string }).error,
          "study_account_changed",
        );
      }
      // The second account's own view never contains the first account's lesson.
      const foreign = await f.call(path, {
        headers: { ...second, "x-study-account": accounts[6].address },
      });
      assert.equal(foreign.status, 404);
      const latest = await f.call(
        "/api/study/lessons?song=" + encodeURIComponent(JSON.stringify(song)),
        { headers: { ...second, "x-study-account": accounts[6].address } },
      );
      assert.equal(await latest.json(), null);
      // Nothing above changed the first account's lesson.
      const kept = (await (
        await f.call(path, { headers: first })
      ).json()) as StudyLesson;
      assert.equal(kept.status, "active");
      assert.equal(kept.progress.presentations, 0);
      assert.equal(kept.current?.attempt ?? null, null);
      assert.equal(f.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);
