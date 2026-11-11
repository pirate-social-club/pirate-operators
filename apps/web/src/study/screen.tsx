import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { StudyLesson } from "../../../../packages/study/lesson.ts";
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
export function StudyScreen(props: {
  client: StudyClient;
  onLesson?: (lesson: StudyLesson) => void;
  onExit?: () => void;
  onConnect?: () => void;
  rewardSlot?: JSX.Element;
  recorder?: StudyingRecorder;
  account?: string;
  completionCapability?: StudyCompletionCapability;
}) {
  const [completed, setCompleted] = createSignal<StudyLesson>();
  const client = createOperatorStudyingClient(props.client, (lesson) => {
    setCompleted(lesson.status === "completed" ? lesson : undefined);
    props.onLesson?.(lesson);
  });
  return (
    <StudyingRouteView
      postId="owned-lesson-port"
      client={client}
      recorder={props.recorder ?? createStudyingBrowserRecorder()}
      onExit={props.onExit}
      onConnect={props.onConnect}
      rewardSlot={props.rewardSlot}
      loadingSlot={<StudyLoading onExit={props.onExit} />}
      renderComplete={
        props.account
          ? (result, actions) => (
              <Show when={completed()}>
                {(lesson) => (
                  <StudyCompletionFlow
                    target={{
                      account: props.account!,
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
                    rewardSlot={props.rewardSlot}
                    onExit={props.onExit}
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
