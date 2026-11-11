// Submit-progress derivation, ported from the React submit-progress-fraction.ts
// plus the production reporter/step lists from
// web/src/app/authenticated-helpers/create-post-submit/{progress,progress-steps}.ts
// (inlined here so the flow story and tests replay the exact production
// emissions without importing app route code).

import type {
  SubmitProgress,
  SubmitProgressDisplay,
  SubmitProgressPhase,
} from "./types.ts";

// Parse a "63%" detail into a 0–1 fraction, or null when there's no byte-progress.
export function parseDetailFraction(detail: string | undefined): number | null {
  const match = detail?.match(/^(\d+(?:\.\d+)?)%$/);
  if (!match) return null;
  return Math.min(Math.max(Number(match[1]) / 100, 0), 1);
}

// A single monotonic 0→1 fill for the whole submit — the bar only ever moves left
// to right, once. Never indeterminate.
// - Multi-step flows (song/video): fill by completed steps, interpolating a byte-%
//   within the current step. Stays monotonic ONLY while the emitted currentIndex
//   is monotonic, so callers must report steps in order.
// - Single-upload flows (image/live cover): the upload is the entire wait, so fill
//   directly by its real byte-% — 0 before it starts, 1 once it's past.
export function submitProgressFraction(progress: SubmitProgress): number {
  const within = parseDetailFraction(progress.detail);

  if (progress.display === "pipeline") {
    const total = Math.max(progress.totalSteps, 1);
    const reached = Math.min(Math.max(progress.currentIndex, 0), total);
    // A step reporting bytes fills its own band [(reached-1)/total, reached/total];
    // a step with no byte-progress counts as reached (end of its band) so the last
    // step lands at 100%.
    return within != null ? (reached - 1 + within) / total : reached / total;
  }

  // activity: the bar tracks the one dominant upload directly.
  if (
    progress.phase === "uploading_media" ||
    progress.phase === "preparing_media"
  ) {
    return within ?? 0;
  }
  if (progress.phase === "validating") return 0;
  return 1; // past the upload (publishing / listing / registration)
}

// ---------------------------------------------------------------------------
// Production reporter + step lists (create-post-submit).
// ---------------------------------------------------------------------------

export type SubmitProgressStep = {
  key: string;
  phase: SubmitProgressPhase;
  label: string;
};

export type SubmitProgressReporter = (key: string, detail?: string) => void;

// Phases that represent genuinely slow, awaited work (network upload, media
// processing, on-chain checks). The bookkeeping phases — validating,
// publishing_post (a single create call), done — are effectively instant, so
// they should not inflate the step counter's denominator.
const MEANINGFUL_PROGRESS_PHASES: ReadonlySet<SubmitProgressPhase> = new Set([
  "preparing_media",
  "uploading_media",
  "processing_media",
  "checking_rights",
  "creating_listing",
  "checking_registration",
]);

// Decide presentation from the *actual* built step list rather than the composer
// type, so a flow that collapses to a single slow step at runtime (e.g. a song
// post reusing a pre-uploaded bundle) is presented as activity, not a misleading
// "1/4"-style pipeline.
function resolveSubmitProgressDisplay(
  steps: SubmitProgressStep[],
): SubmitProgressDisplay {
  const meaningfulCount = steps.reduce(
    (count, step) =>
      MEANINGFUL_PROGRESS_PHASES.has(step.phase) ? count + 1 : count,
    0,
  );
  return meaningfulCount >= 2 ? "pipeline" : "activity";
}

export function createSubmitProgressReporter(
  steps: SubmitProgressStep[],
  emit: (progress: SubmitProgress) => void,
): SubmitProgressReporter {
  // "done" is a terminal completion signal (it stops the button spinner right
  // before the composer navigates to the new post), not a unit of work. Exclude
  // it from the counter so the last real step rests at "N/N" instead of the count
  // being inflated by a step the user never actually waits through.
  const byKey = new Map<string, SubmitProgressStep>();
  const countedIndex = new Map<string, number>();
  let counted = 0;
  for (const step of steps) {
    byKey.set(step.key, step);
    if (step.phase !== "done") {
      counted += 1;
      countedIndex.set(step.key, counted);
    }
  }
  const totalSteps = counted;
  const display = resolveSubmitProgressDisplay(steps);

  return (key, detail) => {
    const step = byKey.get(key);
    if (step === undefined) return;
    emit({
      phase: step.phase,
      label: step.label,
      detail,
      // done reports as complete (N/N); real steps report their counted position.
      currentIndex:
        step.phase === "done"
          ? totalSteps
          : (countedIndex.get(key) ?? totalSteps),
      totalSteps,
      display,
    });
  };
}

// Ordered submit-progress step lists per post type. Shared between the live
// submit flow and Storybook, so the composer's progress presentation can be
// reviewed against the exact steps production emits.

export function songSubmitProgressSteps(input: {
  hasPendingBundle: boolean;
  hasExtraArtifacts: boolean;
  isLocked: boolean;
}): SubmitProgressStep[] {
  const steps: SubmitProgressStep[] = [
    { key: "validating", phase: "validating", label: "Checking details" },
  ];
  if (!input.hasPendingBundle) {
    steps.push({
      key: "upload_primary_audio",
      phase: "uploading_media",
      label: "Uploading audio",
    });
    if (input.hasExtraArtifacts) {
      steps.push({
        key: "upload_artifacts",
        phase: "uploading_media",
        label: "Uploading files",
      });
    }
    steps.push({
      key: "create_bundle",
      phase: "processing_media",
      label: "Preparing song",
    });
  }
  steps.push({
    key: "publish_post",
    phase: "publishing_post",
    label: "Publishing",
  });
  steps.push({
    key: "done",
    phase: "done",
    label: input.isLocked ? "Post processing" : "Post published",
  });
  return steps;
}

export function videoSubmitProgressSteps(_input: {
  monetized: boolean;
}): SubmitProgressStep[] {
  const steps: SubmitProgressStep[] = [
    { key: "validating", phase: "validating", label: "Checking details" },
    { key: "upload_video", phase: "uploading_media", label: "Uploading video" },
    {
      key: "analysis",
      phase: "processing_media",
      label: "Checking video and soundtrack",
    },
    { key: "publish_post", phase: "publishing_post", label: "Publishing" },
  ];
  steps.push({ key: "done", phase: "done", label: "Post published" });
  return steps;
}

export function simpleSubmitProgressSteps(input: {
  mode: "text" | "image" | "link" | "live" | "file";
  monetized?: boolean;
  hasMedia?: boolean;
}): SubmitProgressStep[] {
  const steps: SubmitProgressStep[] = [
    { key: "validating", phase: "validating", label: "Checking details" },
  ];
  if (input.hasMedia) {
    steps.push({
      key: "prepare_media",
      phase: input.mode === "image" ? "uploading_media" : "preparing_media",
      label:
        input.mode === "live"
          ? "Preparing media"
          : input.mode === "file"
            ? "Uploading file"
            : "Uploading image",
    });
  }
  if (input.monetized) {
    steps.push({
      key: "create_listing",
      phase: "creating_listing",
      label: "Creating listing",
    });
  }
  steps.push(
    {
      key: "publish_post",
      phase: "publishing_post",
      label: input.mode === "live" ? "Publishing live room" : "Publishing",
    },
    {
      key: "done",
      phase: "done",
      label: input.mode === "live" ? "Live room published" : "Post published",
    },
  );
  return steps;
}
