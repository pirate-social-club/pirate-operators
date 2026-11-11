// Unrun source-flow regressions; exact completion ports are injected memory doubles.
import { render, type JSX } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import {
  StudyCompletionFlow,
  type StudyCompletionCapability,
  type StudyCompletionTarget,
} from "../src/study/completion-flow.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
function mount(ui: () => JSX.Element) {
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(render(ui, host));
  return host;
}
const target: StudyCompletionTarget = {
  account: "fixture-account",
  communityId: "fixture-community",
  postId: "fixture-post",
  lessonId: "fixture-lesson",
};
const result = {
  kind: "complete" as const,
  correctCount: 3,
  totalCount: 4,
  scorePercent: 75,
};
function press(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button!.click();
}
function capability(): Extract<
  StudyCompletionCapability,
  { state: "available" }
> {
  return {
    state: "available",
    resolveAccount: vi.fn(async () => target.account),
    consumeEarnedSignal: vi.fn(() => true),
    readCompletion: vi.fn<
      Extract<
        StudyCompletionCapability,
        { state: "available" }
      >["readCompletion"]
    >(async () => ({
      target,
      timezone: "UTC",
      decision: {
        status: "qualified",
        streak_day: "2026-11-11",
        earned_day: {
          status: "recorded",
          song_day_newly_earned: true,
          signal_id: "exact-signal",
        },
      },
    })),
    readProgress: vi.fn(async () => ({
      timezone: "UTC",
      timezone_pinned: true,
      today: "2026-11-11",
      streak: { last_day: "2026-11-11", current: 4 },
      week: {
        days: Array.from({ length: 7 }, (_, index) => ({
          day: index === 0 ? "2026-11-11" : `fixture-day-${index}`,
          earned: index === 0,
        })),
      },
    })),
  };
}
test("missing earned-day capability shows the actual score and Continue exits directly", () => {
  const exit = vi.fn();
  const host = mount(() => (
    <StudyCompletionFlow
      target={target}
      result={result}
      capability={{
        state: "unavailable",
        reason: "No exact-lesson earned-day API",
      }}
      onExit={exit}
    />
  ));
  expect(host.textContent).toContain("3/4");
  expect(host.textContent).not.toContain("day streak");
  press(host, "Continue");
  expect(exit).toHaveBeenCalledOnce();
});
test("qualified exact-lesson evidence follows source results then streak choreography", async () => {
  const port = capability(),
    exit = vi.fn();
  const host = mount(() => (
    <StudyCompletionFlow
      target={target}
      result={result}
      capability={port}
      onExit={exit}
    />
  ));
  await vi.waitFor(() => expect(port.resolveAccount).toHaveBeenCalledTimes(2));
  expect(host.textContent).not.toContain("day streak");
  press(host, "Continue");
  await vi.waitFor(() => expect(host.textContent).toContain("day streak"));
  expect(port.consumeEarnedSignal).toHaveBeenCalledWith(
    target.account,
    "exact-signal",
  );
  press(host, "Continue");
  expect(exit).toHaveBeenCalledOnce();
});
test("another lesson or a late account change cannot manufacture a streak step", async () => {
  const port = capability(),
    exit = vi.fn();
  vi.mocked(port.resolveAccount)
    .mockResolvedValueOnce(target.account)
    .mockResolvedValue("different-account");
  const host = mount(() => (
    <StudyCompletionFlow
      target={target}
      result={result}
      capability={port}
      onExit={exit}
    />
  ));
  await vi.waitFor(() => expect(port.resolveAccount).toHaveBeenCalledTimes(2));
  press(host, "Continue");
  expect(exit).toHaveBeenCalledOnce();
  expect(port.consumeEarnedSignal).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("day streak");
});
test("target mismatch refuses progress reads and preserves authoritative score", async () => {
  const port = capability();
  vi.mocked(port.readCompletion).mockResolvedValue({
    target: { ...target, lessonId: "other-lesson" },
    timezone: "UTC",
    decision: {
      status: "qualified",
      streak_day: "2026-11-11",
      earned_day: {
        status: "recorded",
        song_day_newly_earned: true,
        signal_id: "other-signal",
      },
    },
  });
  const host = mount(() => (
    <StudyCompletionFlow target={target} result={result} capability={port} />
  ));
  await vi.waitFor(() => expect(port.readCompletion).toHaveBeenCalledOnce());
  expect(port.readProgress).not.toHaveBeenCalled();
  expect(host.textContent).toContain("3/4");
});
