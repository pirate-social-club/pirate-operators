import { createSignal, onCleanup, Show } from "solid-js";
import type {
  StudyLesson,
  StudySong,
} from "../../../../packages/study/lesson.ts";
import type { StudyPublicationReceipt } from "../../../../packages/study/publication-view.ts";
import { createStudyClient, type StudyClient } from "../study/client.ts";
import { StudyScreen } from "../study/screen.tsx";
import { Button } from "../ui.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/overlays/dialog/dialog";
import { get, post } from "./api.ts";
import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";
import { enrollmentDisclosure } from "./learning-consent.ts";
import {
  ensureStudyEnrollment,
  type StudyEnrollmentView,
} from "./study-enrollment.ts";

interface Publication {
  state: "unbound" | "bound" | StudyPublicationReceipt["state"];
  receipt: StudyPublicationReceipt | null;
}
export function LiveStudy(props: {
  postId: string;
  title: string;
  csrf: string;
  wallet: KaraokeWallet;
  onExit(): void;
  onLearningActions?: (actions: { download: () => Promise<void> }) => void;
}) {
  const [client, setClient] = createSignal<StudyClient | null>(null),
    [error, setError] = createSignal(""),
    [consent, setConsent] = createSignal<KaraokeConsentRequest | null>(null),
    [publication, setPublication] = createSignal<Publication | null>(null),
    [checking, setChecking] = createSignal(false),
    [terminalId, setTerminalId] = createSignal<string | undefined>();
  let active = true,
    answer: ((accepted: boolean) => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    polls = 0;
  const answerConsent = (accepted: boolean) => {
    const resolve = answer;
    answer = undefined;
    setConsent(null);
    resolve?.(accepted);
  };
  onCleanup(() => {
    active = false;
    clearTimeout(timer);
    answerConsent(false);
  });
  const beforeStart = () =>
    ensureStudyEnrollment({
      active: () => active,
      request: () =>
        post<StudyEnrollmentView>(
          "/api/karaoke/enrollment",
          { activity: "study" },
          props.csrf,
        ),
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          if (!active) return resolve(false);
          answer = resolve;
          setConsent(request);
        }),
      submit: (request, signature) =>
        post<{ state: string }>(
          "/api/karaoke/enrollment",
          {
            enrollment: request.message,
            target: request.target,
            signature,
          },
          props.csrf,
        ),
      wallet: props.wallet,
    });
  async function load() {
    setError("");
    try {
      const song = await get<StudySong>(
        `/api/study/song?postId=${encodeURIComponent(props.postId)}`,
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
          beforeStart,
          () => active,
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
      await get(`/api/study/lessons/${encodeURIComponent(id)}`);
      if (!active || terminalId() !== id) return;
      const value = await post<Publication>(
        `/api/study/lessons/${encodeURIComponent(id)}/publication`,
        {},
        props.csrf,
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
    const value = await post(
      `/api/study/lessons/${encodeURIComponent(id)}/history`,
      {},
      props.csrf,
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `study-history-${id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const publicationMessage = () => {
    const value = publication();
    if (
      value?.state === "published" &&
      value.receipt?.canonicalRevision?.status === 5
    )
      return value.receipt.confirmed
        ? "Your public learning result was invalidated. Its public history is preserved."
        : "Your public learning result invalidation is confirming.";
    if (
      value?.state === "published" &&
      (value.receipt?.canonicalRevision?.revision ?? 1) > 1
    )
      return value.receipt?.confirmed
        ? "Your corrected public learning result is published."
        : "Your corrected public learning result is confirming.";
    if (value?.state === "published")
      return value.receipt?.confirmed
        ? "Your public learning result is published."
        : "Your public learning result is confirming.";
    if (value?.state === "private")
      return "This lesson was saved privately. No public result was published.";
    if (value?.state === "failed")
      return "Publication needs operator review. Your lesson is saved.";
    return "Your lesson is saved. Public result publication is pending.";
  };
  return (
    <section class="live-study" aria-label={`Study: ${props.title}`}>
      <div class="study-navigation">
        <Button variant="ghost" onClick={props.onExit}>
          Back to songs
        </Button>
        <span>{props.title}</span>
      </div>
      <Show
        when={client()}
        fallback={
          <div class="study-page">
            <h1>Study</h1>
            <Show
              when={error()}
              fallback={<p role="status">Loading your song…</p>}
            >
              <p role="alert">{error()}</p>
              <Button onClick={() => void load()}>Try again</Button>
            </Show>
          </div>
        }
      >
        {(current) => <StudyScreen client={current()} onLesson={observe} />}
      </Show>
      <Show when={terminalId() && client()}>
        <div class="study-publication">
          <p role="status">{publicationMessage()}</p>
          <Button
            variant="outline"
            disabled={checking()}
            onClick={() => {
              polls = 0;
              void checkPublication();
            }}
          >
            {checking() ? "Checking publication…" : "Check publication"}
          </Button>
        </div>
      </Show>
      <Dialog
        open={consent() !== null}
        onOpenChange={(open) => {
          if (!open) answerConsent(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable public learning results</DialogTitle>
            <DialogDescription>
              Your{" "}
              {String(consent()?.message.activities) === "3"
                ? "Karaoke and Study"
                : "Study"}{" "}
              results, song, selected lines, first-scored grades and completion
              time will be permanently public under your wallet address. This
              includes unfinished and unsuccessful lessons. Your permission
              lasts until its stated end date or until you withdraw it.
            </DialogDescription>
          </DialogHeader>
          <p>
            <a
              href={
                consent()
                  ? enrollmentDisclosure(consent()!).termsUrl
                  : undefined
              }
              target="_blank"
              rel="noopener"
            >
              Terms
            </a>{" "}
            ·{" "}
            <a
              href={
                consent()
                  ? enrollmentDisclosure(consent()!).privacyUrl
                  : undefined
              }
              target="_blank"
              rel="noopener"
            >
              Privacy
            </a>
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => answerConsent(false)}>
              Cancel
            </Button>
            <Button onClick={() => answerConsent(true)}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
