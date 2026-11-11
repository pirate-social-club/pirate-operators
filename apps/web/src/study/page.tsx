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
import type { LearningPublicationView } from "./publication-status.tsx";
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
  onLearningActions?(actions: { download(): Promise<void> } | null): void;
  rewardSlot?: JSX.Element;
  completionCapability?: StudyCompletionCapability;
}

/** Source route composition with the community's account/lesson service port.
 * Shell keys this page by account+post and owns every URL transition.
 */
export function StudyPage(props: StudyPageProps) {
  return (
    <Show
      when={
        props.account
          ? `${props.account}\u0000${props.postId}\u0000${props.lessonId ?? ""}`
          : null
      }
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
      {(_identity: string) => (
        <OwnedStudyPage {...props} account={props.account!} />
      )}
    </Show>
  );
}

function OwnedStudyPage(props: StudyPageProps & { account: string }) {
  const owner = {
    account: props.account,
    postId: props.postId,
    lessonId: props.lessonId,
  };
  const actions = props.onLearningActions;
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
  const current = () =>
    active &&
    props.account === owner.account &&
    props.postId === owner.postId &&
    props.lessonId === owner.lessonId;
  const clearActions = () => actions?.(null);
  onCleanup(() => {
    active = false;
    generation += 1;
    clearTimeout(timer);
    clearActions();
  });
  const request = async <T,>(path: string, body?: unknown) => {
    if (!current()) throw new Error("This Study was closed or replaced.");
    const value = await learningRequest<T>(path, {
      account: owner.account,
      csrf: props.csrf,
      body,
    });
    if (!current()) throw new Error("This Study was closed or replaced.");
    return value;
  };
  const enroll = () => {
    if (!props.wallet)
      return Promise.reject(
        new Error("Connect your MOSS account to continue Study."),
      );
    return ensureStudyEnrollment({
      active: current,
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
    clearActions();
    setError("");
    setClient(undefined);
    try {
      const song = await request<StudySong>(
        `/api/study/song?postId=${encodeURIComponent(props.postId)}`,
      );
      if (!current() || generation !== revision) return;
      setClient(
        createStudyClient(
          song,
          () => props.csrf,
          props.lessonId,
          (id) => {
            if (current() && generation === revision)
              props.onLessonOpened?.(id);
          },
          props.signInPermission ? undefined : enroll,
          () => current() && generation === revision,
          owner.account,
        ),
      );
    } catch (error) {
      if (!current() || generation !== revision) return;
      if (
        (error as { status?: number }).status === 401 ||
        (error as { code?: string }).code === "study_account_changed"
      ) {
        clearActions();
        setAuth(true);
      } else
        setError(
          error instanceof Error
            ? error.message
            : "We couldn't load this study session.",
        );
    }
  }
  function observe(lesson: StudyLesson) {
    if (!current()) return;
    const revision = generation;
    actions?.({
      download: async () => {
        if (!current() || revision !== generation)
          throw new Error("This Study was closed.");
        const history = await request(
          `/api/study/lessons/${encodeURIComponent(lesson.lessonId)}/history`,
          {},
        );
        if (!current() || revision !== generation) return;
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
  if (typeof window !== "undefined")
    queueMicrotask(() => {
      if (!!active) void load();
    });
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
            postId={owner.postId}
            lessonId={owner.lessonId}
            completionCapability={props.completionCapability}
            onLesson={observe}
            onLessonCleared={clearActions}
            onExit={props.onExit}
            onConnect={props.onConnect}
            rewardSlot={props.rewardSlot}
          />
        )}
      </Show>
    </Show>
  );
}
