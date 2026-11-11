import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import type {
  StudyLesson,
  StudySong,
} from "../../../../packages/study/lesson.ts";
import { createStudyClient, type StudyClient } from "./client.ts";
import { StudyScreen, StudyLoading } from "./screen.tsx";
import {
  StudyAuthRequiredState,
  StudyRouteLoadFailureState,
} from "./presentation/studying-route-states.tsx";
import {
  StudyPublicationStatus,
  type LearningPublicationView,
} from "./publication-status.tsx";
import type { StudyCompletionCapability } from "./completion-flow.tsx";
import { learningRequest } from "../karaoke/operator-learning-http.ts";
import type { KaraokeWallet } from "../live/learning-consent.ts";
import {
  ensureStudyEnrollment,
  type StudyEnrollmentView,
} from "../live/study-enrollment.ts";

export interface StudyPageProps {
  postId: string;
  title: string;
  account: string | null;
  csrf: string;
  wallet?: KaraokeWallet;
  signInPermission?: boolean;
  lessonId?: string;
  onExit(): void;
  onConnect?(): void;
  onLessonOpened?(lessonId: string): void;
  onLearningActions?(actions: { download(): Promise<void> }): void;
  rewardSlot?: JSX.Element;
  completionCapability?: StudyCompletionCapability;
}

/** Source route composition with the community's account/lesson service port.
 * Shell keys this page by account+post and owns every URL transition.
 */
export function StudyPage(props: StudyPageProps) {
  return (
    <Show
      when={props.account ? `${props.account}\u0000${props.postId}` : null}
      keyed
      fallback={
        <StudyAuthRequiredState
          title="Sign in to study"
          description="Study packs follow the song's community. Sign in to pick up your lesson and streak."
          onConnect={props.onConnect}
          onExit={props.onExit}
        />
      }
    >
      {() => <OwnedStudyPage {...props} account={props.account!} />}
    </Show>
  );
}

function OwnedStudyPage(props: StudyPageProps & { account: string }) {
  const [client, setClient] = createSignal<StudyClient>();
  const [error, setError] = createSignal("");
  const [auth, setAuth] = createSignal(false);
  const [publication, setPublication] =
    createSignal<LearningPublicationView | null>(null);
  const [checking, setChecking] = createSignal(false);
  let terminalId: string | undefined,
    polls = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  let active = true,
    generation = 0;
  onCleanup(() => {
    active = false;
    generation += 1;
    clearTimeout(timer);
  });
  const request = <T,>(path: string, body?: unknown) =>
    learningRequest<T>(path, {
      account: props.account,
      csrf: props.csrf,
      body,
    });
  const enroll = () => {
    if (!props.wallet)
      return Promise.reject(
        new Error("Connect your MOSS account to continue Study."),
      );
    return ensureStudyEnrollment({
      active: () => active,
      wallet: props.wallet,
      request: () =>
        request<StudyEnrollmentView>("/api/karaoke/enrollment", {
          activity: "study",
        }),
      submit: (value, signature) =>
        request<{ state: string }>("/api/karaoke/enrollment", {
          enrollment: value.message,
          target: value.target,
          signature,
        }),
    });
  };
  async function load() {
    const revision = ++generation;
    setError("");
    setClient(undefined);
    try {
      const song = await request<StudySong>(
        `/api/study/song?postId=${encodeURIComponent(props.postId)}`,
      );
      if (!active || generation !== revision) return;
      setClient(
        createStudyClient(
          song,
          () => props.csrf,
          props.lessonId,
          props.onLessonOpened,
          props.signInPermission ? undefined : enroll,
          () => active,
          props.account,
        ),
      );
    } catch (error) {
      if (!active || generation !== revision) return;
      if (
        (error as { status?: number }).status === 401 ||
        (error as { code?: string }).code === "study_account_changed"
      )
        setAuth(true);
      else
        setError(
          error instanceof Error
            ? error.message
            : "We couldn't load this study session.",
        );
    }
  }
  function observe(lesson: StudyLesson) {
    if (!active) return;
    props.onLearningActions?.({
      download: async () => {
        if (!active) throw new Error("This Study was closed.");
        const history = await request(
          `/api/study/lessons/${encodeURIComponent(lesson.lessonId)}/history`,
          {},
        );
        if (!active) return;
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(history, null, 2)], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = `study-history-${lesson.lessonId}.json`;
        link.click();
        URL.revokeObjectURL(url);
      },
    });
    if (lesson.status === "active") {
      terminalId = undefined;
      clearTimeout(timer);
      setPublication(null);
      return;
    }
    if (terminalId !== lesson.lessonId) {
      terminalId = lesson.lessonId;
      polls = 0;
      setPublication(null);
      void checkPublication();
    }
  }
  async function checkPublication() {
    const id = terminalId;
    if (!active || !id || checking()) return;
    clearTimeout(timer);
    setChecking(true);
    try {
      await request(`/api/study/lessons/${encodeURIComponent(id)}`);
      if (!active || id !== terminalId) return;
      const result = await request<LearningPublicationView>(
        `/api/study/lessons/${encodeURIComponent(id)}/publication`,
        {},
      );
      if (active && id === terminalId) setPublication(result);
    } catch {
      /* A lost receipt never replaces the saved grade or implies success. */
    } finally {
      if (active) setChecking(false);
      const value = publication();
      if (
        active &&
        id === terminalId &&
        ++polls < 20 &&
        value?.state !== "private" &&
        value?.state !== "failed" &&
        !(value?.state === "published" && value.receipt?.confirmed)
      )
        timer = setTimeout(() => void checkPublication(), 3000);
    }
  }
  void load();
  return (
    <Show
      when={!auth()}
      fallback={
        <StudyAuthRequiredState
          title="Sign in to study"
          description="Sign in to pick up your lesson and streak."
          onConnect={props.onConnect}
          onExit={props.onExit}
        />
      }
    >
      <Show
        when={client()}
        fallback={
          <Show
            when={error()}
            fallback={<StudyLoading onExit={props.onExit} />}
          >
            <StudyRouteLoadFailureState
              title="Study unavailable"
              description={error()}
              onRetry={() => void load()}
              onGoHome={props.onExit}
            />
          </Show>
        }
      >
        {(value) => (
          <StudyScreen
            client={value()}
            account={props.account}
            completionCapability={props.completionCapability}
            onLesson={observe}
            onExit={props.onExit}
            onConnect={props.onConnect}
            rewardSlot={
              <>
                <StudyPublicationStatus
                  value={publication()}
                  checking={checking()}
                  onCheck={() => void checkPublication()}
                />
                {props.rewardSlot}
              </>
            }
          />
        )}
      </Show>
    </Show>
  );
}
