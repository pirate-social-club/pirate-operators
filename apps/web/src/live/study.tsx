import { createSignal, onCleanup, Show } from "solid-js";
import type {
  StudyLesson,
  StudySong,
} from "../../../../packages/study/lesson.ts";
import type { StudyPublicationReceipt } from "../../../../packages/study/publication-view.ts";
import { createStudyClient, type StudyClient } from "../study/client.ts";
import { StudyScreen, StudyLoading } from "../study/screen.tsx";
import { StudyRouteLoadFailureState } from "../study/presentation/studying-route-states.tsx";
import { get, post } from "./api.ts";
import type { KaraokeWallet } from "./learning-consent.ts";
import { enrollStudyForAccount } from "../study/enrollment-intent.ts";

interface Publication {
  state: "unbound" | "bound" | StudyPublicationReceipt["state"];
  receipt: StudyPublicationReceipt | null;
}
export function LiveStudy(props: {
  postId: string;
  title: string;
  csrf: string;
  /** The signed-in account whose lessons this Study may show. */
  account: string;
  wallet: KaraokeWallet;
  /** V4: signing in is the publication permission; no enrollment step. */
  signInPermission?: boolean;
  onExit(): void;
  onLearningActions?: (
    actions: { download: () => Promise<void> } | null,
  ) => void;
}) {
  // Every Study request names the account this page belongs to.
  const owner = () => ({ "x-study-account": props.account });
  const [client, setClient] = createSignal<StudyClient | null>(null),
    [error, setError] = createSignal(""),
    [publication, setPublication] = createSignal<Publication | null>(null),
    [checking, setChecking] = createSignal(false),
    [terminalId, setTerminalId] = createSignal<string | undefined>();
  let active = true,
    timer: ReturnType<typeof setTimeout> | undefined,
    polls = 0;
  onCleanup(() => {
    active = false;
    clearTimeout(timer);
    props.onLearningActions?.(null);
  });
  // A V3 community keeps its enrollment step before a new lesson. In a V4
  // community a lesson binds the sign-in; the client retries briefly while
  // that sign-in is still being recorded.
  const enroll = () =>
    enrollStudyForAccount({
      account: () => props.account,
      csrf: () => props.csrf,
      active: () => active,
      wallet: props.wallet,
    });
  async function load() {
    setError("");
    try {
      const song = await get<StudySong>(
        `/api/study/song?postId=${encodeURIComponent(props.postId)}`,
        { headers: owner() },
      );
      if (!active) return;
      const initial =
        new URL(location.href).searchParams.get("lesson") ?? undefined;
      setClient(
        createStudyClient(
          song,
          () => props.csrf,
          initial,
          (id) => {
            if (!active) return;
            const url = new URL(location.href);
            url.searchParams.set("study", props.postId);
            url.searchParams.set("lesson", id);
            history.replaceState(null, "", url);
          },
          props.signInPermission ? undefined : enroll,
          () => active,
          props.account,
        ),
      );
    } catch (failure) {
      if (active)
        setError(
          failure instanceof Error
            ? failure.message
            : "Study is unavailable. Try again.",
        );
    }
  }
  void load();
  async function checkPublication(id = terminalId()) {
    if (!active || !id || checking()) return;
    clearTimeout(timer);
    setChecking(true);
    try {
      // Reconcile a saved terminal result before reading its durable receipt.
      await get(`/api/study/lessons/${encodeURIComponent(id)}`, {
        headers: owner(),
      });
      if (!active || terminalId() !== id) return;
      const value = await post<Publication>(
        `/api/study/lessons/${encodeURIComponent(id)}/publication`,
        {},
        props.csrf,
        owner(),
      );
      if (!active || terminalId() !== id) return;
      setPublication(value);
    } catch {
      // Keep the saved lesson visible; publication can recover independently.
    } finally {
      if (active && terminalId() === id) {
        setChecking(false);
        const value = publication();
        if (
          ++polls < 20 &&
          value?.state !== "failed" &&
          value?.state !== "private" &&
          !(value?.state === "published" && value.receipt?.confirmed)
        )
          timer = setTimeout(() => void checkPublication(), 3000);
      }
    }
  }
  function observe(lesson: StudyLesson) {
    if (!active) return;
    props.onLearningActions?.({
      download: () => downloadHistory(lesson.lessonId),
    });
    if (lesson.status === "active") {
      setTerminalId(undefined);
      setChecking(false);
      clearTimeout(timer);
      setPublication(null);
      return;
    }
    if (terminalId() === lesson.lessonId) return;
    setTerminalId(lesson.lessonId);
    polls = 0;
    setPublication(null);
    void checkPublication(lesson.lessonId);
  }
  async function downloadHistory(id: string) {
    if (!active) throw new Error("This Study was closed.");
    const value = await post(
      `/api/study/lessons/${encodeURIComponent(id)}/history`,
      {},
      props.csrf,
      owner(),
    );
    if (!active) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `study-history-${id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section class="live-study" aria-label={`Study: ${props.title}`}>
      <Show
        when={client()}
        fallback={
          <Show
            when={error()}
            fallback={<StudyLoading onExit={props.onExit} />}
          >
            <StudyRouteLoadFailureState
              title="Study is unavailable"
              description={error()}
              onRetry={() => void load()}
              onGoHome={props.onExit}
            />
          </Show>
        }
      >
        {(current) => (
          <StudyScreen
            client={current()}
            account={props.account}
            postId={props.postId}
            onLessonCleared={() => props.onLearningActions?.(null)}
            onLesson={observe}
            onExit={props.onExit}
          />
        )}
      </Show>
    </section>
  );
}
