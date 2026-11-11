// UNRUN. Actual StudyScreen/controller/adapter, with a delayed response body.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { StudyScreen } from "../src/study/screen.tsx";
import type { StudyClient } from "../src/study/client.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
} from "../../../packages/study/lesson.ts";
import type { StudyingRecorder } from "../src/study/studying-route-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function lesson(id: string): StudyLesson {
  const song = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: `0x${"2".repeat(64)}`,
    postId: "post-a",
    lyricRevision: 1,
  };
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: id,
    song,
    startedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: null,
    status: "active",
    completionReason: null,
    current: {
      line: {
        ...song,
        lineId: "line-a",
        lineVersion: 1,
        text: "I am going home",
        language: "en",
        manifestDigest: "fixture-digest",
      },
      presentationNumber: 1,
      takeNumber: 1,
      attempt: null,
    },
    lastAttempt: null,
    progress: {
      total: 4,
      resolved: 0,
      mastered: 0,
      presentations: 0,
      presentationCap: 12,
      firstPassGraded: 0,
      firstPassCorrect: 0,
    },
    qualification: "not_evaluated",
  };
}
function fixture(id: string) {
  const value = lesson(id);
  const attempt = {
    schema: "pirate.study.attempt/1" as const,
    kind: "say-it-back" as const,
    attemptId: `${id}-attempt`,
    line: value.current!.line,
    policy: "script_aware_token_phonetic_v5" as const,
    startedAt: 1,
    completedAt: null,
    state: "ready" as const,
    grade: null,
    failure: null,
    lesson: { lessonId: id, presentationNumber: 1, takeNumber: 1 },
    recordingDurationMs: null,
    qualification: "not_evaluated" as const,
  };
  let body!: (value: StudyLessonSubmission) => void;
  const client: StudyClient = {
    load: async () => value,
    refresh: async () => value,
    restart: async () => value,
    open: async () => ({ attempt, lesson: value }),
    submit: vi.fn(async () => {
      // The HTTP headers can have arrived while the response body remains live.
      const response = {
        json: () =>
          new Promise<StudyLessonSubmission>((resolve) => {
            body = resolve;
          }),
      };
      return response.json();
    }),
  };
  return {
    client,
    value,
    release: () =>
      body({
        lesson: {
          ...value,
          current: null,
          status: "completed",
          completedAt: 2,
          progress: { ...value.progress, resolved: 4, firstPassCorrect: 3 },
        },
        attempt: {
          ...attempt,
          state: "assessed",
          grade: {
            correct: true,
            matchKind: "exact",
            policyRevision: "script_aware_token_phonetic_v5",
          },
        },
      }),
  };
}
const recorder: StudyingRecorder = {
  start: async () => {},
  stop: async () => ({
    audio: new Blob(["audio"], { type: "audio/webm" }),
    contentType: "audio/webm",
    durationMs: 1000,
  }),
  cancel: async () => {},
};
async function press(host: HTMLElement, label: string) {
  const control = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  });
  control.click();
}
for (const boundary of [
  "disposed",
  "account",
  "post",
  "lesson",
  "client",
] as const)
  test(`late body after ${boundary} cannot reinstall old private actions`, async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const old = fixture("old-lesson"),
      next = fixture("new-lesson");
    const [scope, setScope] = createSignal({
      account: "account-a",
      postId: "post-a",
      lessonId: "old-lesson",
      client: old.client,
    });
    const seen: string[] = [],
      cleared = vi.fn();
    let privateAction: string | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(
      () => (
        <StudyScreen
          {...scope()}
          recorder={recorder}
          onLesson={(value) => {
            seen.push(value.lessonId);
            privateAction = value.lessonId;
          }}
          onLessonCleared={() => {
            privateAction = null;
            cleared();
          }}
          onExit={() => {}}
        />
      ),
      host,
    );
    cleanups.push(dispose);
    await press(host, "Record");
    await press(host, "Stop");
    await vi.waitFor(() => expect(old.client.submit).toHaveBeenCalledOnce());
    if (boundary === "disposed") {
      dispose();
      cleanups.pop();
      expect(privateAction).toBeNull();
    } else {
      old.client.load = async () => next.value;
      setScope((value) => ({
        ...value,
        client: boundary === "client" ? next.client : value.client,
        account: boundary === "account" ? "account-b" : value.account,
        postId: boundary === "post" ? "post-b" : value.postId,
        lessonId: boundary === "lesson" ? "new-lesson" : value.lessonId,
      }));
      await vi.waitFor(() => expect(cleared).toHaveBeenCalled());
      await vi.waitFor(() => expect(seen.length).toBe(2));
      expect(privateAction).toBe("new-lesson");
    }
    const retained = privateAction,
      count = seen.length;
    old.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(count);
    expect(privateAction).toBe(retained);
    expect(cleared).toHaveBeenCalled();
  });
