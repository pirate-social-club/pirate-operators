// Source transition cases from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; local service error seam. UNRUN by lane directive.
import { render, type JSX } from "@solidjs/web";
import { createRoot } from "solid-js";

import { afterEach, expect, test, vi } from "vitest";
import { StudyingRouteView } from "../src/study/studying-route-view.tsx";
import type {
  StudyingClient,
  StudyingLessonPayload,
  StudyingRecorder,
} from "../src/study/studying-route-model.ts";

const disposers: Array<() => void> = [];
function mount(ui: () => JSX.Element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let dispose = () => {};
  createRoot((cleanup) => {
    dispose = cleanup;
    render(ui, container);
  });
  disposers.push(dispose);
  return { container, dispose };
}
function lesson(): StudyingLessonPayload {
  return {
    post_id: "song",
    session_id: "session",
    served_count: 4,
    resolved_count: 0,
    spoken_submission: null,
    exercises: [
      {
        id: "item",
        type: "say_it_back",
        line_index: 0,
        max_attempts: 3,
        prompt_text: "Say this line",
        presentation_count: 0,
      },
    ],
  };
}
function recorder(durationMs = 1_000) {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn<StudyingRecorder["stop"]>(async () => ({
      audio: new Blob(["audio"], { type: "audio/webm" }),
      contentType: "audio/webm",
      durationMs,
    })),
    cancel: vi.fn(async () => {}),
  } satisfies StudyingRecorder;
}
function client(payload = lesson()) {
  return {
    loadLesson: vi.fn(async () => payload),
    submitAttempt: vi.fn<StudyingClient["submitAttempt"]>(
      () => new Promise(() => {}),
    ),
  };
}
function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === text,
  );
}
async function press(container: HTMLElement, text: string) {
  const control = await vi.waitFor(() => {
    const found = button(container, text);
    expect(found).toBeDefined();
    return found!;
  });
  control.click();
}
async function recordAndSubmit(container: HTMLElement) {
  await press(container, "Record");
  await press(container, "Stop");
}
function rejection(
  reason:
    | "study_provider_outcome_unknown"
    | "study_provider_refused"
    | "study_recording_too_short",
) {
  const short = reason === "study_recording_too_short";
  const details = short
    ? {
        reason_code: reason,
        next_action: "record_again",
        minimum_duration_ms: 1_000,
      }
    : {
        reason_code: reason,
        next_action:
          reason === "study_provider_outcome_unknown"
            ? "operator_review"
            : "record_again",
      };
  return Object.assign(new Error("Study recording rejected"), {
    status: short ? 400 : 409,
    details,
  });
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

test("does not offer Stop until microphone acquisition has completed", async () => {
  let acquired = () => {};
  const capture = recorder();
  capture.start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acquired = resolve;
      }),
  );
  const api = client();
  const { container } = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await press(container, "Record");
  await vi.waitFor(() =>
    expect(button(container, "Starting microphone…")?.disabled).toBe(true),
  );
  expect(button(container, "Stop")).toBeUndefined();
  button(container, "Starting microphone…")?.click();
  expect(capture.stop).not.toHaveBeenCalled();
  acquired();
  await press(container, "Stop");
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledOnce());
});

test("a denied microphone returns to Record without submitting", async () => {
  const capture = recorder();
  capture.start.mockRejectedValue(new Error("Microphone permission denied"));
  const api = client();
  const { container } = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await press(container, "Record");
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Microphone permission denied"),
  );
  expect(button(container, "Record")?.disabled).toBe(false);
  expect(capture.stop).not.toHaveBeenCalled();
  expect(api.submitAttempt).not.toHaveBeenCalled();
});

test("an expired lesson keeps saved progress and requires an explicit new-lesson action", async () => {
  const api = client({
    ...lesson(),
    expired: true,
    resolved_count: 2,
    exercises: [],
  });
  const capture = recorder();
  const restart = vi.fn();
  const { container } = mount(() => (
    <StudyingRouteView
      postId="song"
      client={api}
      recorder={capture}
      onStudyAgain={restart}
      rewardSlot={<div>Completion rewards</div>}
    />
  ));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Study session expired"),
  );
  expect(container.textContent).toContain("Your progress is saved");
  expect(container.textContent).toContain("2 of 4 cards resolved");
  expect(button(container, "Record")).toBeUndefined();
  expect(container.textContent).not.toContain("Completion rewards");
  expect(restart).not.toHaveBeenCalled();
  expect(capture.start).not.toHaveBeenCalled();
  expect(api.submitAttempt).not.toHaveBeenCalled();
  await press(container, "Start new lesson");
  expect(restart).toHaveBeenCalledOnce();
});

test("a refusal at natural expiry reloads into recovery instead of another recording", async () => {
  const api = client();
  api.loadLesson
    .mockResolvedValueOnce(lesson())
    .mockResolvedValue({ ...lesson(), expired: true, exercises: [] });
  api.submitAttempt.mockRejectedValue({ status: 404, code: "not_found" });
  const capture = recorder();
  const { container } = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await recordAndSubmit(container);
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Study session expired"),
  );
  expect(api.loadLesson).toHaveBeenCalledTimes(2);
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  expect(button(container, "Record")).toBeUndefined();
  expect(capture.cancel).toHaveBeenCalled();
});

test.each([353, 999])(
  "refuses a %i ms new recording before any provider submission",
  async (duration) => {
    const api = client();
    const { container } = mount(() => (
      <StudyingRouteView
        postId="song"
        client={api}
        recorder={recorder(duration)}
      />
    ));
    await recordAndSubmit(container);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Record for at least one second"),
    );
    expect(button(container, "Record")?.disabled).toBe(false);
    expect(api.submitAttempt).not.toHaveBeenCalled();
    expect(api.loadLesson).toHaveBeenCalledOnce();
  },
);

test("the one-second boundary submits the captured bytes once", async () => {
  const api = client();
  const capture = recorder(1_000);
  const { container } = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await recordAndSubmit(container);
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledOnce());
  expect(api.submitAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      audio_duration_ms: 1_000,
      exercise_id: "item",
      attempt_number: 1,
    }),
  );
  expect(capture.stop).toHaveBeenCalledOnce();
});

test.each(["study_provider_refused", "study_recording_too_short"] as const)(
  "%s allows fresh audio without a generic conflict reload",
  async (reason) => {
    const api = client();
    api.submitAttempt.mockRejectedValue(rejection(reason));
    const capture = recorder();
    const { container } = mount(() => (
      <StudyingRouteView postId="song" client={api} recorder={capture} />
    ));
    await recordAndSubmit(container);
    await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledOnce());
    await recordAndSubmit(container);
    await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(2));
    const first = api.submitAttempt.mock.calls[0]![0];
    const second = api.submitAttempt.mock.calls[1]![0];
    expect(first.attempt_number).toBe(second.attempt_number);
    expect(first.idempotency_key).not.toBe(second.idempotency_key);
    expect(api.loadLesson).toHaveBeenCalledOnce();
  },
);

test("an unknown provider outcome blocks recording and offers only an explicit new lesson", async () => {
  const api = client();
  api.submitAttempt.mockRejectedValue(
    rejection("study_provider_outcome_unknown"),
  );
  const capture = recorder();
  const exit = vi.fn();
  const studyAgain = vi.fn();
  const { container } = mount(() => (
    <StudyingRouteView
      postId="song"
      client={api}
      recorder={capture}
      onExit={exit}
      onStudyAgain={studyAgain}
    />
  ));
  await recordAndSubmit(container);
  await vi.waitFor(() =>
    expect(button(container, "Recording paused")?.disabled).toBe(true),
  );
  expect(container.textContent).toContain("start over with a new lesson");
  button(container, "Recording paused")?.click();
  expect(button(container, "Record")).toBeUndefined();
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  expect(api.loadLesson).toHaveBeenCalledOnce();
  expect(studyAgain).not.toHaveBeenCalled();
  await press(container, "Study again");
  expect(studyAgain).toHaveBeenCalledOnce();
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  container
    .querySelector<HTMLButtonElement>('[aria-label="Exit study"]')
    ?.click();
  expect(exit).toHaveBeenCalledOnce();
});

test("a fresh route read retains the exact blocked card and cannot start capture", async () => {
  const payload = lesson();
  payload.spoken_submission = {
    state: "provider_outcome_unknown",
    session_item_id: "item",
    attempt_number: 1,
    next_action: "operator_review",
  };
  const api = client(payload);
  const capture = recorder();
  const studyAgain = vi.fn();
  const first = mount(() => (
    <StudyingRouteView
      postId="song"
      client={api}
      recorder={capture}
      onStudyAgain={studyAgain}
    />
  ));
  await vi.waitFor(() =>
    expect(button(first.container, "Recording paused")?.disabled).toBe(true),
  );
  first.dispose();
  first.container.remove();
  const next = mount(() => (
    <StudyingRouteView
      postId="song"
      client={api}
      recorder={capture}
      onStudyAgain={studyAgain}
    />
  ));
  await vi.waitFor(() =>
    expect(button(next.container, "Recording paused")?.disabled).toBe(true),
  );
  expect(capture.start).not.toHaveBeenCalled();
  expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(api.loadLesson).toHaveBeenCalledTimes(2);
  expect(studyAgain).not.toHaveBeenCalled();
  await press(next.container, "Study again");
  expect(studyAgain).toHaveBeenCalledOnce();
  expect(api.submitAttempt).not.toHaveBeenCalled();
});

test("leaving during microphone acquisition cancels and ignores the late grant", async () => {
  let acquired = () => {};
  const capture = recorder();
  capture.start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acquired = resolve;
      }),
  );
  const api = client();
  const ui = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await press(ui.container, "Record");
  ui.dispose();
  expect(capture.cancel).toHaveBeenCalledOnce();
  acquired();
  await Promise.resolve();
  expect(capture.stop).not.toHaveBeenCalled();
  expect(api.submitAttempt).not.toHaveBeenCalled();
});

test("leaving while the recorder finishes cannot submit late audio", async () => {
  let stopped: (
    audio: Awaited<ReturnType<StudyingRecorder["stop"]>>,
  ) => void = () => {};
  const capture = recorder();
  capture.stop.mockImplementation(
    () =>
      new Promise((resolve) => {
        stopped = resolve;
      }),
  );
  const api = client();
  const ui = mount(() => (
    <StudyingRouteView postId="song" client={api} recorder={capture} />
  ));
  await recordAndSubmit(ui.container);
  ui.dispose();
  stopped({
    audio: new Blob(["audio"]),
    contentType: "audio/webm",
    durationMs: 1_000,
  });
  await Promise.resolve();
  expect(capture.cancel).toHaveBeenCalledOnce();
  expect(api.submitAttempt).not.toHaveBeenCalled();
});
