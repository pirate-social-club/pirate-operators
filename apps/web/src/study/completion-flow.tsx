// Independently owned choreography from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db
// src/features/studying/study-completion-flow.tsx. Central auth, persona and
// private API replaced by an explicit exact-lesson completion capability.
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { StudyingSurfaceState } from "./presentation/studying-model.ts";
import { StudyingSurface } from "./presentation/studying-surface.tsx";
import { bindLearningPageLifecycle } from "./private-page-lifecycle.ts";

type CompleteState = Extract<StudyingSurfaceState, { kind: "complete" }>;
export interface StudyCompletionTarget {
  account: string;
  communityId: string;
  postId: string;
  lessonId: string;
}
/** Only a reviewed exact-attempt backend can supply this capability. Current
 * operator lesson APIs provide grades/publication, not these earned-day facts.
 * Keeping it unavailable never inserts an extra step or invents a streak.
 */
export type StudyCompletionCapability =
  | { state: "unavailable"; reason: string }
  | {
      state: "available";
      resolveAccount(signal: AbortSignal): Promise<string | null>;
      readCompletion(
        target: StudyCompletionTarget,
        signal: AbortSignal,
      ): Promise<{
        target: StudyCompletionTarget;
        timezone: string;
        decision: {
          status:
            | "qualified"
            | "pending"
            | "not_qualified"
            | "refused"
            | "unknown";
          streak_day: string;
          earned_day: {
            status: "recorded" | "unavailable";
            song_day_newly_earned: boolean;
            signal_id: string;
          };
        };
      }>;
      readProgress(
        target: StudyCompletionTarget,
        signal: AbortSignal,
      ): Promise<{
        timezone: string;
        timezone_pinned: boolean;
        today: string;
        streak: { last_day: string; current: number };
        week: { days: readonly { day: string; earned: boolean }[] };
      }>;
      consumeEarnedSignal(account: string, signalId: string): boolean;
    };

export interface StudyCompletionFlowProps {
  target: StudyCompletionTarget;
  result: CompleteState;
  capability: StudyCompletionCapability;
  rewardSlot?: JSX.Element;
  onExit?(): void;
  onStudyAgain?(): void;
}

/** Source results-first flow; only exact, fresh account-bound evidence may add
 * the original streak screen after Continue. Optional reads cannot hold results.
 */
export function StudyCompletionFlow(props: StudyCompletionFlowProps) {
  const [earned, setEarned] = createSignal<{
    signalId: string;
    count: number;
    week: readonly boolean[];
  }>();
  const [showStreak, setShowStreak] = createSignal(false);
  let generation = 0,
    disposed = false;
  let controller: AbortController | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const identity = () =>
    JSON.stringify([
      props.target.account,
      props.target.communityId,
      props.target.postId,
      props.target.lessonId,
    ]);
  const invalidate = () => {
    ++generation;
    controller?.abort();
    clearTimeout(timer);
    setEarned(undefined);
    setShowStreak(false);
  };
  async function load() {
    invalidate();
    const capability = props.capability;
    if (capability.state !== "available") return;
    const revision = generation,
      key = identity(),
      target = { ...props.target };
    const request = new AbortController();
    controller = request;
    const current = () =>
      !disposed &&
      revision === generation &&
      identity() === key &&
      !request.signal.aborted;
    timer = setTimeout(() => {
      if (current()) request.abort();
    }, 10000);
    try {
      const account = await capability.resolveAccount(request.signal);
      if (!current() || account !== target.account) return;
      const completion = await capability.readCompletion(
        target,
        request.signal,
      );
      if (
        !current() ||
        JSON.stringify([
          completion.target.account,
          completion.target.communityId,
          completion.target.postId,
          completion.target.lessonId,
        ]) !== key
      )
        return;
      const decision = completion.decision;
      if (
        decision.status !== "qualified" ||
        decision.earned_day.status !== "recorded" ||
        !decision.earned_day.song_day_newly_earned
      )
        return;
      const progress = await capability.readProgress(target, request.signal);
      if (
        !current() ||
        progress.timezone !== completion.timezone ||
        !progress.timezone_pinned ||
        progress.today !== decision.streak_day ||
        progress.streak.last_day !== decision.streak_day ||
        progress.streak.current < 1 ||
        progress.week.days.length !== 7 ||
        !progress.week.days.some(
          (day) => day.day === decision.streak_day && day.earned,
        )
      )
        return;
      if (
        (await capability.resolveAccount(request.signal)) !== target.account ||
        !current()
      )
        return;
      setEarned({
        signalId: decision.earned_day.signal_id,
        count: progress.streak.current,
        week: progress.week.days.map((day) => day.earned),
      });
    } catch {
      /* The authoritative completed score survives optional read failure. */
    } finally {
      if (generation === revision) clearTimeout(timer);
    }
  }
  createEffect(identity, () => {
    const revision = ++generation;
    controller?.abort();
    setEarned(undefined);
    setShowStreak(false);
    if (typeof window !== "undefined")
      queueMicrotask(() => {
        if (!disposed && revision === generation) void load();
      });
  });
  onCleanup(() => {
    disposed = true;
    invalidate();
  });
  onCleanup(
    bindLearningPageLifecycle(invalidate, () => {
      if (!disposed) void load();
    }),
  );
  const continueResult = () => {
    const value = earned(),
      capability = props.capability;
    if (
      !showStreak() &&
      value &&
      capability.state === "available" &&
      capability.consumeEarnedSignal(props.target.account, value.signalId)
    )
      setShowStreak(true);
    else props.onExit?.();
  };
  const surface = (): CompleteState => {
    const value = earned();
    return showStreak() && value
      ? {
          ...props.result,
          previousStreak: undefined,
          streak: { currentStreak: value.count, qualifiedToday: true },
          streakWeek: value.week,
        }
      : {
          ...props.result,
          streak: undefined,
          previousStreak: undefined,
          streakWeek: undefined,
        };
  };
  return (
    <StudyingSurface
      state={surface()}
      rewardSlot={showStreak() ? undefined : props.rewardSlot}
      onExit={continueResult}
      onStudyAgain={showStreak() ? undefined : props.onStudyAgain}
    />
  );
}
