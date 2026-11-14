// UNRUN. Actual copied Solid route/model/surface; controlled client promises
// represent its server seam, not live backend/provider grading qualification.
import { render, type JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { StudyingRouteView } from "../src/study/studying-route-view.tsx";
import type { StudyingAttemptResult } from "../src/study/presentation/studying-model.ts";
import type {
  StudyingClient,
  StudyingLessonPayload,
} from "../src/study/studying-route-model.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lesson(prompt = "Original private prompt"): StudyingLessonPayload {
  return {
    post_id: "post-a",
    session_id: "session-a",
    served_count: 2,
    resolved_count: 0,
    spoken_submission: null,
    exercises: [{
      id: "choice-a",
      type: "translation_choice",
      line_index: 0,
      max_attempts: 1,
      presentation_count: 0,
      prompt_text: prompt,
      question: "Choose the meaning:",
      options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }],
    }],
  };
}
function graded(outcome: "correct" | "incorrect"): StudyingAttemptResult {
  return {
    outcome,
    attempt_state: "spent",
    attempts_remaining: 0,
    correct_option_id: outcome === "correct" ? "a" : "b",
    session: { first_pass_correct_count: outcome === "correct" ? 1 : 0 },
    next_lesson: {
      resolved_count: 1,
      exercises: [{
        id: "server-next",
        type: "say_it_back",
        line_index: 1,
        presentation_count: 0,
        prompt_text: "Server next card",
      }],
    },
  };
}
function client(payload = lesson()) {
  const grade = deferred<StudyingAttemptResult>();
  return {
    grade,
    loadLesson: vi.fn(async () => payload),
    submitAttempt: vi.fn<StudyingClient["submitAttempt"]>(() => grade.promise),
  };
}
function mount(ui: () => JSX.Element) {
  const host = document.createElement("div");
  document.body.append(host);
  const rawDispose = render(ui, host);
  let alive = true;
  const dispose = () => { if (alive) { alive = false; rawDispose(); } };
  disposers.push(dispose);
  return { host, dispose };
}
const sound = () => ({ unlock: vi.fn(), play: vi.fn(), dispose: vi.fn() });
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === text);
}
async function ready(host: HTMLElement) {
  await vi.waitFor(() => expect(button(host, "Option A")).toBeDefined());
}
function noGrade(host: HTMLElement) {
  expect(host.querySelector("[data-study-result]")).toBeNull();
  expect(button(host, "Next")).toBeUndefined();
  expect(host.textContent).not.toContain("Checking");
}

test.each(["correct", "incorrect"] as const)(
  "a delayed %s response retains feedback until explicit Next, with one request",
  async (outcome) => {
    const api = client(), feedback = sound();
    const { host } = mount(() => <StudyingRouteView postId="post-a" client={api} feedback={feedback} />);
    await ready(host);
    const optionA = button(host, "Option A")!, optionB = button(host, "Option B")!;
    optionA.click();
    optionA.click();
    optionB.click();
    await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(1));
    const input = api.submitAttempt.mock.calls[0]![0];
    expect(input).toMatchObject({
      type: "translation_choice", session_id: "session-a", exercise_id: "choice-a",
      attempt_number: 1, selected_option_id: "a", idempotency_key: expect.any(String),
    });
    expect(optionA.disabled).toBe(true);
    expect(optionB.disabled).toBe(true);
    expect(optionA.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[aria-label="Answer choices"]')?.getAttribute("aria-busy")).toBe("true");
    noGrade(host);
    expect(feedback.play).not.toHaveBeenCalled();

    vi.useFakeTimers();
    api.grade.resolve(graded(outcome));
    await vi.advanceTimersByTimeAsync(0);
    const result = outcome === "correct" ? "correct" : "incorrect";
    expect(host.querySelector(`[data-study-result="${result}"]`)).not.toBeNull();
    expect(button(host, "Next")?.disabled).toBe(false);
    expect(host.textContent).toContain("Original private prompt");
    expect(host.textContent).not.toContain("Server next card");
    expect(feedback.play).toHaveBeenCalledTimes(1);
    expect(feedback.play).toHaveBeenCalledWith(outcome);

    // Controlled clock beyond the retired 700ms policy, never a readiness wait.
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.querySelector(`[data-study-result="${result}"]`)).not.toBeNull();
    expect(host.textContent).toContain("Original private prompt");
    expect(api.submitAttempt).toHaveBeenCalledTimes(1);
    const next = button(host, "Next")!;
    next.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.textContent).toContain("Server next card");
    expect(host.textContent).not.toContain("Original private prompt");
    expect(button(host, "Next")).toBeUndefined();
    expect(api.submitAttempt).toHaveBeenCalledTimes(1);
    expect(api.loadLesson).toHaveBeenCalledTimes(1);
    expect(api.loadLesson).toHaveBeenCalledWith("post-a");
  },
);

test("a server-retained retry waits for Next and uses its next attempt identity", async () => {
  const payload = lesson();
  payload.exercises[0]!.max_attempts = 2;
  const api = client(payload);
  const { host } = mount(() => <StudyingRouteView postId="post-a" client={api} feedback={sound()} />);
  await ready(host);
  button(host, "Option A")!.click();
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(1));
  const original = api.submitAttempt.mock.calls[0]![0];
  const nextRequest = deferred<StudyingAttemptResult>();
  api.submitAttempt.mockImplementation(() => nextRequest.promise);
  api.grade.resolve({
    outcome: "incorrect", attempt_state: "retryable", attempts_remaining: 1,
    next_lesson: { exercises: [{ ...payload.exercises[0]!, presentation_count: 1 }] },
  });
  await vi.waitFor(() => expect(button(host, "Next")).toBeDefined());
  expect(host.querySelector('[data-study-result="incorrect"]')).not.toBeNull();
  expect(api.submitAttempt).toHaveBeenCalledTimes(1);
  button(host, "Next")!.click();
  await vi.waitFor(() => expect(button(host, "Option B")?.disabled).toBe(false));
  noGrade(host);
  button(host, "Option B")!.click();
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(2));
  expect(api.submitAttempt.mock.calls[1]![0]).toMatchObject({
    type: "translation_choice", session_id: "session-a", exercise_id: "choice-a",
    attempt_number: 2, selected_option_id: "b",
  });
  expect(api.submitAttempt.mock.calls[1]![0].idempotency_key).not.toBe(original.idempotency_key);
});

test("refusal never produces a grade or an automatic retry; explicit retry retains the original key", async () => {
  const api = client();
  const { host } = mount(() => <StudyingRouteView postId="post-a" client={api} feedback={sound()} />);
  await ready(host);
  button(host, "Option A")!.click();
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(1));
  const original = api.submitAttempt.mock.calls[0]![0];
  api.grade.reject(Object.assign(new Error("Answer service refused this request."), { status: 503 }));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Answer service refused this request."));
  noGrade(host);
  expect(api.submitAttempt).toHaveBeenCalledTimes(1);
  const retry = deferred<StudyingAttemptResult>();
  api.submitAttempt.mockImplementation(() => retry.promise);
  button(host, "Option A")!.click();
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(2));
  expect(api.submitAttempt.mock.calls[1]![0]).toEqual(original);
  noGrade(host);
});

test.each([401, 403])("authority refusal %s masks the card instead of revealing feedback", async (status) => {
  const api = client(), feedback = sound();
  const { host } = mount(() => <StudyingRouteView postId="post-a" client={api} feedback={feedback} />);
  await ready(host);
  button(host, "Option A")!.click();
  await vi.waitFor(() => expect(api.submitAttempt).toHaveBeenCalledTimes(1));
  api.grade.reject(Object.assign(new Error("Sign in again to continue."), { status }));
  await vi.waitFor(() => expect(host.textContent).toContain("Sign in to study"));
  expect(host.textContent).not.toContain("Original private prompt");
  noGrade(host);
  expect(feedback.play).not.toHaveBeenCalled();
  expect(api.submitAttempt).toHaveBeenCalledTimes(1);
});

test.each(["post", "account", "dispose"] as const)(
  "a late original grade after %s lifetime replacement cannot restore private feedback",
  async (boundary) => {
    const nextPost = boundary === "post" ? "post-b" : "post-a";
    const old = client(), replacement = client({ ...lesson("New owner prompt"), post_id: nextPost, session_id: "session-b" });
    const feedback = sound();
    // Keyed host lifetimes model the existing page owner's disposal boundary;
    // these keys are not sent as account/session authority to the client.
    const [owner, setOwner] = createSignal({ key: "owner-a", postId: "post-a", client: old });
    const { host, dispose } = mount(() => (
      <Show when={owner()} keyed>
        {(scope) => <StudyingRouteView postId={scope.postId} client={scope.client} feedback={feedback} />}
      </Show>
    ));
    await ready(host);
    button(host, "Option A")!.click();
    await vi.waitFor(() => expect(old.submitAttempt).toHaveBeenCalledTimes(1));
    if (boundary === "dispose") dispose();
    else {
      setOwner({ key: boundary === "account" ? "owner-b" : "owner-a", postId: nextPost, client: replacement });
      await vi.waitFor(() => expect(host.textContent).toContain("New owner prompt"));
    }
    vi.useFakeTimers();
    old.grade.resolve(graded("correct"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.textContent).not.toContain("Original private prompt");
    expect(host.textContent).not.toContain("Server next card");
    noGrade(host);
    expect(feedback.play).not.toHaveBeenCalled();
    expect(replacement.submitAttempt).not.toHaveBeenCalled();
    expect(old.submitAttempt).toHaveBeenCalledTimes(1);
  },
);
