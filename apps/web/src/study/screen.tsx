import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { StudyLesson } from "../../../../packages/study/lesson.ts";
import { Type } from "./ui.ts";
import type { StudyClient } from "./client.ts";
import { createOperatorStudyingClient } from "./operator-studying-adapter.ts";
import { createStudyingBrowserRecorder } from "./studying-browser-recorder.ts";
import { StudyingRouteView } from "./studying-route-view.tsx";
import type { StudyingRecorder } from "./studying-route-model.ts";
import { StudyRouteLoadingState } from "./presentation/studying-route-states.tsx";
import { ActivityProgressHeader } from "../karaoke/activity-progress-header.tsx";
import {
  StudyCompletionFlow,
  type StudyCompletionCapability,
} from "./completion-flow.tsx";

/** Existing mount contract now delegates to the selected source controller. */
export interface StudyScreenProps {
  client: StudyClient;
  onLesson?: (lesson: StudyLesson) => void;
  onExit?: () => void;
  onConnect?: () => void;
  rewardSlot?: JSX.Element;
  recorder?: StudyingRecorder;
  account?: string;
  postId?: string;
  lessonId?: string;
  onLessonCleared?: () => void;
  completionCapability?: StudyCompletionCapability;
}
export function StudyScreen(props: StudyScreenProps) {
  const scope = createMemo(() => ({
    client: props.client,
    account: props.account,
    postId: props.postId,
    lessonId: props.lessonId,
  }));
  return (
    <Show when={scope()} keyed>
      {(owner) => <OwnedStudyScreen {...props} owner={owner} />}
    </Show>
  );
}
function OwnedStudyScreen(
  props: StudyScreenProps & {
    owner: {
      client: StudyClient;
      account?: string;
      postId?: string;
      lessonId?: string;
    };
  },
) {
  const owner = props.owner,
    onLesson = props.onLesson,
    clearLesson = props.onLessonCleared;
  let active = true;
  const current = () =>
    active &&
    props.client === owner.client &&
    props.account === owner.account &&
    props.postId === owner.postId &&
    props.lessonId === owner.lessonId;
  const recorder = props.recorder ?? createStudyingBrowserRecorder();
  const [completed, setCompleted] = createSignal<StudyLesson>();
  const client = createOperatorStudyingClient(
    owner.client,
    (lesson) => {
      if (!current()) return;
      setCompleted(lesson.status === "completed" ? lesson : undefined);
      onLesson?.(lesson);
    },
    {
      isActive: current,
      onLoading: () => {
        if (current()) {
          // A restart request does not erase the authoritative old result.
          // Replacement facts arrive through onLesson; auth/disposal still clear.
          clearLesson?.();
        }
      },
    },
  );
  const invalidate = () => {
    if (!active) return;
    active = false;
    client.dispose();
    void recorder.cancel?.();
    clearLesson?.();
  };
  const clear = () => {
    if (current()) {
      setCompleted(undefined);
      invalidate();
    }
  };
  const exit = () => {
    invalidate();
    props.onExit?.();
  };
  onCleanup(invalidate);
  return (
    <StudyingRouteView
      postId={owner.postId ?? "owned-lesson-port"}
      client={client}
      recorder={recorder}
      onExit={exit}
      onConnect={props.onConnect}
      onAuthRequired={clear}
      rewardSlot={props.rewardSlot}
      loadingSlot={<StudyLoading onExit={exit} />}
      renderComplete={
        owner.account
          ? (result, actions) => (
              <Show when={completed()}>
                {(lesson) => (
                  <StudyCompletionFlow
                    target={{
                      account: owner.account!,
                      communityId: lesson().song.communityId,
                      postId: lesson().song.postId,
                      lessonId: lesson().lessonId,
                    }}
                    result={result}
                    capability={
                      props.completionCapability ?? {
                        state: "unavailable",
                        reason:
                          "The operator does not expose exact-lesson earned-day credit.",
                      }
                    }
                    rewardSlot={
                      <>
                        <Show when={actions.restartError}>
                          <Type
                            as="p"
                            class="text-destructive-text"
                            role="alert"
                            variant="caption"
                          >
                            {actions.restartError}
                          </Type>
                        </Show>
                        {props.rewardSlot}
                      </>
                    }
                    onExit={exit}
                    onStudyAgain={actions.studyAgain}
                  />
                )}
              </Show>
            )
          : undefined
      }
    />
  );
}

export function StudyLoading(props: { onExit?: () => void }) {
  return (
    <div class="relative h-dvh w-full">
      <Show when={props.onExit}>
        <div class="absolute inset-x-0 top-0 z-10 mx-auto w-full max-w-[640px]">
          <ActivityProgressHeader
            progressMax={0}
            progressValue={0}
            progressTone="success"
            exitIcon="close"
            exitLabel="Exit study"
            onExit={props.onExit}
          />
        </div>
      </Show>
      <StudyRouteLoadingState label="Loading Study" />
    </div>
  );
}
