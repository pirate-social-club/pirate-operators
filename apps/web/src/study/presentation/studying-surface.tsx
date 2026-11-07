// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-surface.tsx; only imports changed.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import {
  Button,
  cn,
  createMediaQuery,
  IconArrowCounterClockwise,
  IconCheck,
  IconFire,
  IconLock,
  IconMicrophone,
  IconStop,
  IconX,
  Spinner,
  Type,
} from "../ui.ts";
import { ActivityProgressHeader } from "../../karaoke/activity-progress-header.tsx";
import { ActivityResults, clampResultPercent, resultHeadline } from "../../karaoke/activity-results.tsx";
import {
  previousStreakForAnimation,
  primaryActionDisabled,
  primaryActionLabel,
  primaryActionVariant,
  type StudyingSurfaceState,
} from "./studying-model.ts";

// Solid port of the legacy `SongStudySurface`
// (`web/src/components/compositions/song-study/song-study-surface.tsx`).
// Presentational only: state in, callbacks out. Recording, network, and
// timers live at the route-view seam, never here.

export interface StudyingSurfaceProps {
  class?: string;
  lessonProgress?: {
    resolvedCount: number;
    totalCount: number;
  };
  onExit?: () => void;
  onKaraoke?: () => void;
  onOptionSelect?: (optionId: string) => void;
  onPrimaryAction?: () => void;
  onStudyAgain?: () => void;
  /** Overrides the completion CTA for a static state story or host surface. */
  completeActionLabel?: string;
  /** Reward pill rendered into the header progress capsule. */
  rewardLabel?: string;
  /** Rich reward content shown below the header on the completion state. */
  rewardSlot?: JSX.Element;
  sayItBackIdleLabel?: string;
  state: StudyingSurfaceState;
}

function ActivityFooter(props: {
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  primaryDisabled?: boolean;
  primaryIcon?: JSX.Element;
  primaryLabel?: string;
  primaryVariant?: "default" | "destructive" | "secondary";
  secondaryIcon?: JSX.Element;
  secondaryLabel?: string;
  /** Results: "again" and Continue side by side, Continue on the right. */
  results?: boolean;
}) {
  return (
    <Show when={props.primaryLabel}>
      <footer class="sticky bottom-0 z-10 border-t border-border-soft bg-background/95 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 backdrop-blur-xl sm:px-6">
        <div class={cn("mx-auto grid w-full max-w-[640px] gap-3", props.secondaryLabel && (props.results ? "grid-cols-2" : "sm:grid-cols-2"))}>
          <Show when={props.results && props.secondaryLabel}>
            <Button class="h-13 w-full" leadingIcon={props.secondaryIcon} onClick={props.onSecondaryAction} size="lg" variant="secondary">
              {props.secondaryLabel}
            </Button>
          </Show>
          <Button
            class="h-13 w-full"
            disabled={props.primaryDisabled}
            leadingIcon={props.primaryIcon}
            onClick={props.onPrimaryAction}
            size="lg"
            variant={props.primaryVariant ?? "default"}
          >
            {props.primaryLabel}
          </Button>
          <Show when={!props.results && props.secondaryLabel}>
            <Button
              class="h-13 w-full"
              leadingIcon={props.secondaryIcon}
              onClick={props.onSecondaryAction}
              size="lg"
              variant="secondary"
            >
              {props.secondaryLabel}
            </Button>
          </Show>
        </div>
      </footer>
    </Show>
  );
}

/** Shared upper-aligned exercise prompt used by every interactive study type. */
function StudyPrompt(props: {
  instruction: string;
  prompt: string;
  promptClass?: string;
}) {
  return (
    <div class="space-y-2">
      <Type as="p" class="text-sm leading-5 text-muted-foreground" variant="caption">
        {props.instruction}
      </Type>
      <Type
        as="h2"
        class={cn("font-bold leading-tight", props.promptClass ?? "text-3xl")}
        dir="auto"
      >
        {props.prompt}
      </Type>
    </div>
  );
}

function LockedState(props: { state: Extract<StudyingSurfaceState, { kind: "locked" }> }) {
  return (
    <div class="mx-auto grid w-full max-w-md flex-1 place-items-center px-4 py-10 text-center sm:px-6">
      <div>
        <div class="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <IconLock class="size-8" />
        </div>
        <Type as="h2" variant="h2">
          Study unlocks with the song
        </Type>
        <Type as="p" class="mt-2 text-muted-foreground" variant="body">
          Lyrics and translations follow the same access rules as the full track.
        </Type>
        <Show when={props.state.priceLabel}>
          <Type as="p" class="mt-4 text-muted-foreground" variant="caption">
            Full study access is included after purchase.
          </Type>
        </Show>
      </div>
    </div>
  );
}

/**
 * The one result box under a card's content (Paper, Flows/Studying/Session):
 * a coloured border and tint, a check and Correct or a cross and Incorrect,
 * and on a spoken miss what was heard.
 */
function StudyResultBox(props: { correct: boolean; heard?: string; label?: string }) {
  return (
    <div
      class={cn(
        "rounded-[var(--radius-xl)] border px-4 py-3.5",
        props.correct ? "border-[#8fd19e] bg-[#1d2a22]" : "border-[#f0543f] bg-[#3a211d]",
      )}
      data-study-result={props.correct ? "correct" : "incorrect"}
      role="status"
    >
      <div class="flex items-center gap-3">
        <Show when={props.correct} fallback={<IconX aria-hidden="true" class="size-5 shrink-0 text-[#f0543f]" />}>
          <IconCheck aria-hidden="true" class="size-5 shrink-0 text-[#8fd19e]" />
        </Show>
        <Type
          as="p"
          class={cn("text-base font-semibold leading-6", props.correct ? "text-[#8fd19e]" : "text-destructive-text")}
          variant="body-strong"
        >
          {props.label ?? (props.correct ? "Correct" : "Incorrect")}
        </Type>
      </div>
      <Show when={props.heard}>
        {heard => (
          <Type as="p" class="mt-2 text-foreground" data-heard-transcript dir="auto" variant="body">
            You said: “{heard()}”
          </Type>
        )}
      </Show>
    </div>
  );
}

function SayItBackState(props: { state: Extract<StudyingSurfaceState, { kind: "say_it_back" }> }) {
  return (
    <div class="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-6 px-4 pb-10 pt-7 sm:px-6 sm:pt-10">
      <StudyPrompt instruction="Say it back:" prompt={props.state.exercise.prompt} />

      {/* A miss reports Incorrect and what was heard; the owner dropped the
          word diff and the "comes back later" line (Paper, 2026-10-12). */}
      <Show when={props.state.phase === "wrong"}>
        <StudyResultBox
          correct={false}
          heard={props.state.heardTranscript}
          label={props.state.revealReference ? "Incorrect" : "Incorrect — try again"}
        />
      </Show>
      <Show when={props.state.submitError}>
        <Type as="p" class="text-destructive-text" role="alert" variant="caption">
          {props.state.submitError}
        </Type>
      </Show>
      <Show when={props.state.guidance}>
        <Type as="p" class="text-muted-foreground" role="status" variant="body">
          {props.state.guidance}
        </Type>
      </Show>
    </div>
  );
}

function MultipleChoiceState(props: {
  onOptionSelect?: (optionId: string) => void;
  state: Extract<StudyingSurfaceState, { kind: "multiple_choice" }>;
}) {
  return (
    <div class="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-6 px-4 pb-10 pt-7 sm:px-6 sm:pt-10">
      <StudyPrompt
        instruction={props.state.exercise.question}
        prompt={props.state.exercise.prompt}
        promptClass="text-xl"
      />

      <div class="grid gap-3">
        <For each={props.state.exercise.options}>
          {(option) => {
            const selected = () => option.id === props.state.selectedOptionId;
            const correct = () => option.id === props.state.exercise.correctOptionId;
            const revealCorrect = () => Boolean(props.state.result) && correct();
            const revealWrong = () => props.state.result === "wrong" && selected() && !correct();

            return (
              <button
                class={cn(
                  "flex min-h-16 items-center justify-between gap-4 rounded-[var(--radius-xl)] border border-border-soft bg-card px-4 py-3 text-left transition-[border-color,background-color]",
                  !props.state.result && !props.state.submitting && "cursor-pointer hover:border-border",
                  (props.state.result || props.state.submitting) && "cursor-default",
                  selected() && !props.state.result && "border-[#4c8df6] bg-[#16202e]",
                  revealCorrect() && "border-[#8fd19e] bg-[#1d2a22]",
                  revealWrong() && "border-[#f0543f] bg-[#3a211d]",
                )}
                disabled={Boolean(props.state.result) || Boolean(props.state.submitting)}
                onClick={() => props.onOptionSelect?.(option.id)}
                type="button"
              >
                <Type as="span" class="text-sm font-medium leading-5" dir="auto" variant="body-strong">
                  {option.text}
                </Type>
                <Show
                  when={revealCorrect()}
                  fallback={(
                    <Show
                      when={revealWrong()}
                      fallback={(
                        <Show
                          when={selected()}
                          fallback={<span class="size-6 shrink-0 rounded-full border border-border" />}
                        >
                            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-[#4c8df6] text-white">
                            <IconCheck class="size-4" />
                          </span>
                        </Show>
                      )}
                    >
                      <IconX class="size-6 shrink-0 text-[#f0543f]" />
                    </Show>
                  )}
                >
                  <span class="grid size-6 shrink-0 place-items-center rounded-full bg-[#8fd19e] text-[#202326]">
                    <IconCheck class="size-4" />
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>

      {/* The same result box as Say it back (Paper): correct moves on by
          itself; incorrect waits for Continue. */}
      <Show when={props.state.result}>
        {result => <StudyResultBox correct={result() === "correct"} />}
      </Show>

      <Show when={props.state.submitError}>
        <Type as="p" class="text-destructive-text" role="alert" variant="caption">
          {props.state.submitError}
        </Type>
      </Show>
    </div>
  );
}

function usePrefersReducedMotion(): () => boolean {
  return createMediaQuery("(prefers-reduced-motion: reduce)");
}

function StreakSlotNumber(props: { currentStreak: number; previousStreak: number }) {
  const startDelayMs = 450;
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = () => props.currentStreak > props.previousStreak && !prefersReducedMotion();
  const [advanced, setAdvanced] = createSignal(false);

  createEffect(
    () => shouldAnimate(),
    (animate) => {
      if (!animate) {
        setAdvanced(false);
        return;
      }
      setAdvanced(false);
      const timeout = window.setTimeout(() => setAdvanced(true), startDelayMs);
      onCleanup(() => window.clearTimeout(timeout));
    },
  );

  return (
    <Show
      when={shouldAnimate()}
      fallback={(
        <Type
          aria-label={`${props.currentStreak} day streak`}
          as="h2"
          class="mt-1 text-7xl font-bold leading-none tabular-nums sm:text-8xl"
        >
          {props.currentStreak}
        </Type>
      )}
    >
      <h2
        aria-label={`${props.currentStreak} day streak`}
        class="relative mt-1 h-[0.92em] overflow-hidden text-7xl font-bold leading-none tabular-nums sm:text-8xl"
      >
        <span
          aria-hidden="true"
          class={cn(
            "absolute inset-x-0 top-0 block transition-[transform,opacity] duration-[1200ms] ease-out",
            advanced() ? "translate-y-full opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {props.previousStreak}
        </span>
        <span
          aria-hidden="true"
          class={cn(
            "absolute inset-x-0 top-0 block transition-[transform,opacity] duration-[1200ms] ease-out",
            advanced() ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0",
          )}
        >
          {props.currentStreak}
        </span>
      </h2>
    </Show>
  );
}


function WeekStrip(props: { days: readonly boolean[] }) {
  const labels = ["M", "T", "W", "T", "F", "S", "S"];

  return (
    <div aria-label="Current week" class="mt-7 flex w-full max-w-xs justify-between">
      <For each={labels}>
        {(label, index) => (
          <div class="flex flex-col items-center gap-2">
            <Type as="span" class="text-muted-foreground" variant="caption">{label}</Type>
            <span
              class={cn(
                "grid size-7 place-items-center rounded-full",
                props.days[index()] ? "bg-warning text-background" : "border border-border text-muted-foreground",
              )}
            >
              <Show when={props.days[index()]}>
                <IconFire class="size-4" filled />
              </Show>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function CompleteState(props: {
  rewardSlot?: JSX.Element;
  state: Extract<StudyingSurfaceState, { kind: "complete" }>;
}) {
  const score = () => clampResultPercent(props.state.scorePercent);
  const streak = () => props.state.streak;
  const previousStreak = () => previousStreakForAnimation(streak(), props.state.previousStreak);
  const isStreak = () => Boolean(streak()?.qualifiedToday);
  const missed = () => Math.max(0, props.state.totalCount - props.state.correctCount);

  return (
    <Show
      when={isStreak()}
      fallback={(
        <>
          <ActivityResults
            heading={resultHeadline(score(), "Lesson complete!")}
            scoreLabel="Accuracy"
            scorePercent={score()}
            stats={[
              { label: "Correct", value: `${props.state.correctCount}/${props.state.totalCount}`, tone: "success" },
              { label: "Missed", value: String(missed()), tone: "warning" },
            ]}
          />
          <Show when={props.rewardSlot}>
            {slot => <div class="mx-auto w-full max-w-md px-4 pb-6 empty:hidden">{slot()}</div>}
          </Show>
        </>
      )}
    >
      {/* The streak page appears only when the server reports a streak earned today. */}
      <div class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 px-4 py-10 sm:px-6">
        <div class="text-center">
          <div class="mx-auto mb-5 grid size-24 place-items-center rounded-full bg-warning/15 text-warning">
            <IconFire class="size-14" filled />
          </div>
          <Show
            when={previousStreak() !== undefined}
            fallback={<Type as="h2" class="mt-1 text-7xl font-bold leading-none sm:text-8xl">{streak()?.currentStreak}</Type>}
          >
            <StreakSlotNumber currentStreak={streak()!.currentStreak} previousStreak={previousStreak()!} />
          </Show>
          <Type as="p" class="mt-1 font-semibold text-foreground" variant="body">day streak</Type>
          {/* Only a week the server reports; never a placeholder pattern. */}
          <Show when={props.state.streakWeek}>{week => <WeekStrip days={week()} />}</Show>
        </div>
        <Show when={props.rewardSlot}>
          {slot => <div class="w-full empty:hidden">{slot()}</div>}
        </Show>
      </div>
    </Show>
  );
}

function lockedStateOf(state: StudyingSurfaceState) {
  return state.kind === "locked" ? state : undefined;
}
function sayItBackStateOf(state: StudyingSurfaceState) {
  return state.kind === "say_it_back" ? state : undefined;
}
function multipleChoiceStateOf(state: StudyingSurfaceState) {
  return state.kind === "multiple_choice" ? state : undefined;
}
function completeStateOf(state: StudyingSurfaceState) {
  return state.kind === "complete" ? state : undefined;
}

function Body(props: {
  onOptionSelect?: (optionId: string) => void;
  rewardSlot?: JSX.Element;
  state: StudyingSurfaceState;
}) {
  return (
    <>
      <Show when={lockedStateOf(props.state)}>
        {(state) => <LockedState state={state()} />}
      </Show>
      <Show when={sayItBackStateOf(props.state)}>
        {(state) => <SayItBackState state={state()} />}
      </Show>
      <Show when={multipleChoiceStateOf(props.state)}>
        {(state) => (
          <MultipleChoiceState
            onOptionSelect={props.onOptionSelect}
            state={state()}
          />
        )}
      </Show>
      <Show when={completeStateOf(props.state)}>
        {(state) => <CompleteState rewardSlot={props.rewardSlot} state={state()} />}
      </Show>
    </>
  );
}

function primaryActionIcon(state: StudyingSurfaceState): JSX.Element {
  if (state.kind !== "say_it_back") return undefined;
  if (state.phase === "checking" || state.phase === "acquiring") return <Spinner class="size-5" />;
  if (state.phase === "listening") return <IconStop class="size-5" />;
  if (state.phase === "idle" || (state.phase === "wrong" && !state.revealReference)) {
    return <IconMicrophone class="size-5" />;
  }
  return undefined;
}

export function StudyingSurface(props: StudyingSurfaceProps) {
  const complete = () => props.state.kind === "complete";
  const recordingBlocked = () => props.state.kind === "say_it_back" && props.state.phase === "blocked";
  // Results: one Continue back to the song, with "Study again" as the quiet option.
  const primaryLabel = () => complete()
    ? props.completeActionLabel
      ?? (props.onExit ? "Continue" : props.onStudyAgain ? "Study again" : undefined)
    : primaryActionLabel(props.state, props.sayItBackIdleLabel);
  const primaryAction = () => complete()
    ? props.completeActionLabel
      ? props.onPrimaryAction
      : props.onExit ?? props.onStudyAgain
    : props.onPrimaryAction;
  const primaryIcon = () => complete() ? undefined : primaryActionIcon(props.state);
  const secondaryLabel = () => props.onStudyAgain && (recordingBlocked() || (complete() && props.onExit && !props.completeActionLabel)) ? "Study again" : undefined;

  return (
    <section class={cn("flex h-dvh w-full flex-col overflow-y-auto bg-background text-foreground", props.class)}>
      {/* A finished lesson needs no exit arrow or progress bar; Continue leaves. */}
      <Show when={!complete()}>
        {/* Paper: on desktop the header sits in the card's 640 column. The
            shared header stays full width for Karaoke; Study caps it here. */}
        <div class="mx-auto w-full max-w-[640px]" data-study-header>
        <ActivityProgressHeader
          exitIcon="close"
          exitLabel="Exit study"
          onExit={props.onExit}
          progressMax={Math.max(0, props.lessonProgress?.totalCount ?? 0)}
          progressValue={Math.max(0, Math.min(props.lessonProgress?.totalCount ?? 0, props.lessonProgress?.resolvedCount ?? 0))}
          progressTone="success"
          rewardLabel={props.state.kind === "locked" ? undefined : props.rewardLabel}
          rewardPresentation="badge"
        />
        </div>
      </Show>
      <Body onOptionSelect={props.onOptionSelect} rewardSlot={props.rewardSlot} state={props.state} />
      <ActivityFooter
        onPrimaryAction={primaryAction()}
        onSecondaryAction={props.onStudyAgain}
        primaryDisabled={primaryActionDisabled(props.state)}
        primaryIcon={primaryIcon()}
        primaryLabel={primaryLabel()}
        primaryVariant={primaryActionVariant(props.state)}
        secondaryIcon={<IconArrowCounterClockwise class="size-5" />}
        results={complete()}
        secondaryLabel={secondaryLabel()}
      />
    </section>
  );
}
