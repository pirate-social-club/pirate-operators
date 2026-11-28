import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, IconMicrophone } from "../design-system.ts";
import { TelegramConnectionResult } from "./account-settings.tsx";
import {
  TELEGRAM_TRIAL_COMMUNITY_NAME,
  TELEGRAM_TRIAL_USER_ID,
  telegramTrialSong,
  telegramTrialSongs,
  type TelegramGradeResult,
  type TelegramRewardRead,
  type TelegramSpeechSubmission,
  type TelegramTrialAccount,
  type TelegramTrialBoundary,
  type TelegramTrialLessonSeed,
  type TelegramTrialSong,
} from "./guest-trial-contract.ts";
import { createTelegramGuestTrialPreviewBoundary } from "./guest-trial-boundary.ts";

type Language = "en" | "ar";

type LessonState = {
  songId: string;
  lineIndex: number;
  takes: number;
  completed: boolean;
};

type ChatEvent =
  | { id: number; kind: "outgoing"; text: string }
  | { id: number; kind: "prompt"; songId: string; lineIndex: number; take: number; language: Language }
  | { id: number; kind: "voice"; durationLabel: string; songId: string }
  | { id: number; kind: "checking" }
  | { id: number; kind: "correct" }
  | { id: number; kind: "mismatch"; transcript: string }
  | { id: number; kind: "unintelligible" }
  | { id: number; kind: "grading-failure" }
  | { id: number; kind: "result"; songId: string; resultId: string }
  | { id: number; kind: "song-details"; songId: string; reward: TelegramRewardRead | null }
  | { id: number; kind: "language-picker" }
  | { id: number; kind: "language-confirmation"; language: Language }
  | { id: number; kind: "choose-open-lesson"; songIds: readonly string[] }
  | { id: number; kind: "account-connected"; resultId: string };

type WebsiteState =
  | { kind: "signed-out"; resultId: string }
  | { kind: "confirmation"; resultId: string; account: TelegramTrialAccount; generation: number }
  | { kind: "checking"; resultId: string; account: TelegramTrialAccount; generation: number }
  | { kind: "failed"; resultId: string; account: TelegramTrialAccount; generation: number; error: string };

const pageSize = 3;
const accountExplanation =
  "Future lessons will use this account. This lesson stays in your guest history.";

function arabicDigits(value: number) {
  const digits = "٠١٢٣٤٥٦٧٨٩";
  return String(value).replace(/\d/g, (digit) => digits[Number(digit)]);
}

function lessonSeed(seed: TelegramTrialLessonSeed): LessonState {
  const song = telegramTrialSong(seed.songId);
  return {
    songId: seed.songId,
    lineIndex: Math.max(0, Math.min(seed.lineIndex, song.lines.length - 1)),
    takes: Math.max(0, Math.floor(seed.takes)),
    completed: false,
  };
}

export function TelegramGuestTrialRoute(props: {
  boundary?: TelegramTrialBoundary;
  linkingAvailable?: boolean;
  initialLessons?: readonly TelegramTrialLessonSeed[];
}) {
  const boundary = props.boundary ?? createTelegramGuestTrialPreviewBoundary();
  const linkingAvailable = () => props.linkingAvailable !== false;
  const initialLessons = Object.fromEntries(
    (props.initialLessons ?? []).map((seed) => [seed.songId, lessonSeed(seed)]),
  );
  const [lessons, setLessons] = createSignal<Record<string, LessonState>>(initialLessons);
  const [events, setEvents] = createSignal<ChatEvent[]>([]);
  const [pickerPage, setPickerPage] = createSignal(0);
  const [activeSongId, setActiveSongId] = createSignal<string | null>(null);
  const [songContextId, setSongContextId] = createSignal<string | null>(null);
  const [language, setLanguage] = createSignal<Language>("en");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [recordingOpen, setRecordingOpen] = createSignal(false);
  const [pendingGrading, setPendingGrading] = createSignal<{
    songId: string;
    lineIndex: number;
    take: number;
  } | null>(null);
  const [website, setWebsite] = createSignal<WebsiteState | null>(null);
  const [websiteBusy, setWebsiteBusy] = createSignal(false);
  let nextEventId = 1;
  let confirmationGeneration = 0;
  let scrollRegion: HTMLDivElement | undefined;
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });

  const pushEvent = <T extends Omit<ChatEvent, "id">>(event: T) => {
    const id = nextEventId;
    nextEventId += 1;
    setEvents((current) => [...current, { ...event, id } as ChatEvent]);
    return id;
  };
  const updateLesson = (songId: string, update: (lesson: LessonState) => LessonState) => {
    setLessons((current) => {
      const lesson = current[songId];
      return lesson ? { ...current, [songId]: update(lesson) } : current;
    });
  };
  const unfinishedLessons = () =>
    Object.values(lessons()).filter((lesson) => !lesson.completed);
  const orderedSongs = () => {
    const open = new Set(unfinishedLessons().map((lesson) => lesson.songId));
    return [
      ...telegramTrialSongs.filter((song) => open.has(song.id)),
      ...telegramTrialSongs.filter((song) => !open.has(song.id)),
    ];
  };
  const visibleSongs = () => {
    const start = pickerPage() * pageSize;
    return orderedSongs().slice(start, start + pageSize);
  };
  const nextPageCount = () => {
    const start = (pickerPage() + 1) * pageSize;
    return Math.max(0, Math.min(pageSize, orderedSongs().length - start));
  };
  const activeLesson = () => {
    const songId = activeSongId();
    const lesson = songId ? lessons()[songId] : undefined;
    return lesson && !lesson.completed ? lesson : null;
  };

  createEffect(() => events().length, () => {
    if (website()) return;
    requestAnimationFrame(() => {
      if (!scrollRegion) return;
      const pickerOpen = !activeLesson() && events().length === 0;
      scrollRegion.scrollTo({
        top: pickerOpen ? 0 : scrollRegion.scrollHeight,
        behavior: "instant",
      });
    });
  });

  function appendPrompt(songId: string, lesson: LessonState) {
    pushEvent({
      kind: "prompt",
      songId,
      lineIndex: lesson.lineIndex,
      take: lesson.takes,
      language: language(),
    });
  }

  function selectSong(songId: string) {
    const stored = lessons()[songId];
    const existing = stored?.completed
      ? { songId, lineIndex: 0, takes: 0, completed: false }
      : stored ?? { songId, lineIndex: 0, takes: 0, completed: false };
    if (!stored || stored.completed)
      setLessons((current) => ({ ...current, [songId]: existing }));
    setActiveSongId(songId);
    setSongContextId(songId);
    setMenuOpen(false);
    setRecordingOpen(false);
    appendPrompt(songId, existing);
  }

  function returnToSongPicker() {
    setPickerPage(0);
    requestAnimationFrame(() => scrollRegion?.scrollTo({ top: 0, behavior: "instant" }));
  }

  function chooseAnotherSong() {
    setActiveSongId(null);
    setRecordingOpen(false);
    setMenuOpen(false);
    setPickerPage(0);
    requestAnimationFrame(() => scrollRegion?.scrollTo({ top: 0, behavior: "instant" }));
  }

  function applyGrade(result: TelegramGradeResult, songId: string, lineIndex: number, take: number) {
    const song = telegramTrialSong(songId);
    if (result.outcome === "correct") {
      pushEvent({ kind: "correct" });
      if (lineIndex + 1 >= song.lines.length) {
        updateLesson(songId, (lesson) => ({ ...lesson, takes: take + 1, completed: true }));
        setActiveSongId(null);
        setSongContextId(songId);
        pushEvent({ kind: "result", songId, resultId: `guest-result-${songId}` });
        return;
      }
      const next = { lineIndex: lineIndex + 1, takes: take + 1 };
      updateLesson(songId, (lesson) => ({
        ...lesson,
        lineIndex: next.lineIndex,
        takes: next.takes,
      }));
      appendPrompt(songId, {
        songId,
        lineIndex: next.lineIndex,
        takes: next.takes,
        completed: false,
      });
      return;
    }
    if (result.outcome === "mismatch") {
      pushEvent({ kind: "mismatch", transcript: result.transcript });
      appendPrompt(songId, {
        songId,
        lineIndex,
        takes: take,
        completed: false,
      });
    } else pushEvent({ kind: "unintelligible" });
  }

  function submitSpeech(submission: TelegramSpeechSubmission) {
    const lesson = activeLesson();
    if (!lesson || pendingGrading()) return;
    const take = lesson.takes;
    setRecordingOpen(false);
    pushEvent({ kind: "voice", durationLabel: submission.durationLabel, songId: lesson.songId });
    const checkingId = pushEvent({ kind: "checking" });
    setPendingGrading({ songId: lesson.songId, lineIndex: lesson.lineIndex, take });
    void boundary
      .gradeAttempt({
        telegramUserId: TELEGRAM_TRIAL_USER_ID,
        songId: lesson.songId,
        lineIndex: lesson.lineIndex,
        take,
        submission,
      })
      .then((result) => {
        if (!mounted) return;
        setEvents((current) => current.filter((event) => event.id !== checkingId));
        setPendingGrading(null);
        applyGrade(result, lesson.songId, lesson.lineIndex, take);
      })
      .catch(() => {
        if (!mounted) return;
        setEvents((current) => current.filter((event) => event.id !== checkingId));
        setPendingGrading(null);
        pushEvent({ kind: "grading-failure" });
      });
  }

  function openSongDetails(songId: string) {
    const song = telegramTrialSong(songId);
    const id = pushEvent({ kind: "song-details", songId, reward: null });
    void boundary.rewardRead(song).then((reward) => {
      if (!mounted) return;
      setEvents((current) =>
        current.map((event) =>
          event.id === id && event.kind === "song-details"
            ? { ...event, reward }
            : event,
        ),
      );
    });
  }

  function invokeSongControl() {
    pushEvent({ kind: "outgoing", text: "/song" });
    setMenuOpen(false);
    const context = songContextId();
    if (context) {
      openSongDetails(context);
      return;
    }
    const open = unfinishedLessons();
    if (open.length === 0) {
      setPickerPage(0);
      requestAnimationFrame(() => scrollRegion?.scrollTo({ top: 0, behavior: "instant" }));
      return;
    }
    if (open.length === 1) {
      openSongDetails(open[0]!.songId);
      return;
    }
    pushEvent({ kind: "choose-open-lesson", songIds: open.map((lesson) => lesson.songId) });
  }

  function invokeLanguageControl() {
    pushEvent({ kind: "outgoing", text: "/language" });
    pushEvent({ kind: "language-picker" });
    setMenuOpen(false);
  }

  function selectLanguage(next: Language) {
    setLanguage(next);
    pushEvent({ kind: "language-confirmation", language: next });
    if (pendingGrading()) return;
    const lesson = activeLesson();
    if (lesson)
      pushEvent({
        kind: "prompt",
        songId: lesson.songId,
        lineIndex: lesson.lineIndex,
        take: lesson.takes,
        language: next,
      });
  }

  function openWebsite(resultId: string) {
    setRecordingOpen(false);
    setMenuOpen(false);
    const account = boundary.initialAccount();
    if (!account) {
      setWebsite({ kind: "signed-out", resultId });
      return;
    }
    confirmationGeneration += 1;
    setWebsite({ kind: "confirmation", resultId, account, generation: confirmationGeneration });
  }

  function websiteSignIn(kind: "initial" | "replacement") {
    const current = website();
    if (!current) return;
    setWebsiteBusy(true);
    void boundary
      .signIn(kind)
      .then((account) => {
        if (!mounted) return;
        confirmationGeneration += 1;
        setWebsite({
          kind: "confirmation",
          resultId: current.resultId,
          account,
          generation: confirmationGeneration,
        });
      })
      .finally(() => {
        if (mounted) setWebsiteBusy(false);
      });
  }

  function confirmWebsiteAccount() {
    const current = website();
    if (!current || current.kind === "signed-out" || current.kind === "checking") return;
    setWebsite({ ...current, kind: "checking" });
    void boundary
      .confirmLink({
        telegramUserId: TELEGRAM_TRIAL_USER_ID,
        account: current.account,
        resultId: current.resultId,
        confirmationGeneration: current.generation,
      })
      .then(() => {
        if (!mounted) return;
        if (!events().some((event) => event.kind === "account-connected" && event.resultId === current.resultId))
          pushEvent({ kind: "account-connected", resultId: current.resultId });
        setWebsite(null);
      })
      .catch((failure) => {
        if (!mounted) return;
        setWebsite({
          ...current,
          kind: "failed",
          error: failure instanceof Error ? failure.message : "The connection could not finish.",
        });
      });
  }

  function AudioControl(props2: { src: string; label: string }) {
    return (
      <audio
        class="h-10 w-full min-w-0 accent-primary"
        controls
        preload="none"
        src={props2.src}
        aria-label={props2.label}
        data-telegram-audio
      />
    );
  }

  function ProgressSegments(props2: { total: number; current: number; rtl: boolean }) {
    return (
      <div class="flex flex-1 gap-1" dir={props2.rtl ? "rtl" : "ltr"} aria-hidden="true">
        <For each={Array.from({ length: props2.total })}>
          {(_, index) => (
            <span
              class={`h-1 flex-1 rounded-full ${index() <= props2.current ? "bg-primary-text" : "bg-input"}`}
            />
          )}
        </For>
      </div>
    );
  }

  function PromptBubble(props2: Extract<ChatEvent, { kind: "prompt" }>) {
    const song = () => telegramTrialSong(props2.songId);
    const line = () => song().lines[props2.lineIndex]!;
    const rtl = () => props2.language === "ar";
    const position = () => props2.lineIndex + 1;
    return (
      <article
        class="w-full max-w-[320px] rounded-2xl bg-card p-3.5 shadow-sm"
        dir={rtl() ? "rtl" : "ltr"}
        lang={rtl() ? "ar" : "en"}
        data-telegram-line-prompt
        data-song-id={props2.songId}
        data-line-index={props2.lineIndex}
        data-take-count={props2.take}
        data-line-text={line().text}
      >
        <div class="flex items-center gap-2 text-xs font-semibold text-primary-text">
          <span>
            {rtl()
              ? `${arabicDigits(position())}/${arabicDigits(song().lines.length)}`
              : `${position()}/${song().lines.length}`}
          </span>
          <ProgressSegments total={song().lines.length} current={props2.lineIndex} rtl={rtl()} />
        </div>
        <p class="mt-3 text-sm leading-6 text-muted-foreground">
          {rtl() ? "استمع ثم كرّر بالإنجليزية." : "Say it back:"}
        </p>
        <p class="mt-1 text-lg font-semibold leading-6 text-foreground" dir="ltr" lang="en">
          {line().text}
        </p>
        <div class="mt-3 rounded-xl bg-muted p-2" data-reference-audio>
          <AudioControl
            src={boundary.mediaUrl("line", props2.songId, props2.lineIndex)}
            label={`Reference audio for ${line().text}`}
          />
        </div>
      </article>
    );
  }

  function SongDetailsBubble(props2: Extract<ChatEvent, { kind: "song-details" }>) {
    const song = () => telegramTrialSong(props2.songId);
    return (
      <article
        class="w-full max-w-[320px] rounded-2xl bg-card p-3.5 shadow-sm"
        aria-label="Full song and details"
        data-reward-state={props2.reward?.kind ?? "loading"}
      >
        <div class="flex items-center gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            ▶
          </span>
          <div class="min-w-0 flex-1">
                            <h3 class="truncate text-base font-semibold text-foreground">{song().title}</h3>
            <p class="truncate text-xs text-muted-foreground">
              {song().artist} · {song().durationLabel}
            </p>
          </div>
        </div>
        <div class="mt-3">
          <AudioControl src={boundary.mediaUrl("song", props2.songId)} label={`Play ${song().title}`} />
        </div>
        <Show when={props2.reward?.kind === "failed"}>
          <p class="mt-3 text-sm leading-5 text-muted-foreground">Reward information is unavailable.</p>
        </Show>
        <Show when={props2.reward?.kind === "testnet-linking-unavailable"}>
          <p class="mt-3 text-sm leading-5 text-muted-foreground">
            Testnet reward. Requires linked Study. Linking is unavailable in this trial.
          </p>
        </Show>
      </article>
    );
  }

  function LanguagePicker() {
    const choice = (code: Language, label: string) => (
      <button
        type="button"
        class="px-3 py-2.5 text-sm font-semibold text-primary-text transition-colors hover:bg-card-hover disabled:cursor-not-allowed disabled:text-muted-foreground"
        onClick={() => selectLanguage(code)}
      >
        {language() === code ? `✓ ${label}` : label}
      </button>
    );
    return (
      <section class="w-full max-w-[320px] overflow-hidden rounded-2xl bg-card shadow-sm" aria-label="Language for instructions">
        <div class="p-3.5">
          <h3 class="text-base font-semibold text-foreground">Language for instructions</h3>
          <p class="mt-1 text-sm text-muted-foreground">Your lesson stays in English.</p>
        </div>
        <div class="grid grid-cols-2 border-t border-border-soft">
          {choice("en", "English")}
          <button type="button" disabled class="px-3 py-2.5 text-sm font-semibold text-muted-foreground">Русский</button>
          <button type="button" disabled class="px-3 py-2.5 text-sm font-semibold text-muted-foreground">ქართული</button>
          <button type="button" disabled class="px-3 py-2.5 text-sm font-semibold text-muted-foreground">简体中文</button>
          <div class="col-span-2 border-t border-border-soft">{choice("ar", "العربية")}</div>
        </div>
      </section>
    );
  }

  function ResultBubble(props2: Extract<ChatEvent, { kind: "result" }>) {
    return (
      <section class="w-full max-w-[320px] overflow-hidden rounded-2xl bg-card shadow-sm" aria-label="Guest result">
        <h3 class="p-4 text-xl font-semibold leading-7 text-foreground">Great work. 83%</h3>
        <div class="border-t border-border-soft">
          <Show
            when={linkingAvailable()}
            fallback={
              <button
                type="button"
                class="w-full px-4 py-3 text-sm font-semibold text-primary-text hover:bg-card-hover"
                onClick={chooseAnotherSong}
              >
                Choose another song
              </button>
            }
          >
            <button
              type="button"
              class="w-full px-4 py-3 text-sm font-semibold text-primary-text hover:bg-card-hover"
              onClick={() => openWebsite(props2.resultId)}
            >
              Connect account
            </button>
          </Show>
        </div>
      </section>
    );
  }

  function EventView(props2: { event: ChatEvent }) {
    const event = props2.event;
    if (event.kind === "outgoing")
      return (
        <div class="self-end rounded-2xl rounded-br-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          {event.text}
        </div>
      );
    if (event.kind === "prompt") return <PromptBubble {...event} />;
    if (event.kind === "voice")
      return (
        <div
          class="w-full max-w-[260px] self-end rounded-2xl rounded-br-md bg-primary p-2 text-primary-foreground"
          data-telegram-voice
        >
          <AudioControl src={boundary.mediaUrl("voice", event.songId)} label="Your fixture voice recording" />
          <p class="mt-1 text-right text-xs">{event.durationLabel}</p>
        </div>
      );
    if (event.kind === "checking")
      return (
        <p class="w-full max-w-[300px] rounded-2xl bg-card px-4 py-3 text-sm text-muted-foreground" role="status" lang={language() === "ar" ? "ar" : "en"}>
          {language() === "ar" ? "جارٍ التحقق من إجابتك الأخيرة" : "Checking your last answer"}
        </p>
      );
    if (event.kind === "correct")
      return (
        <p class="w-fit rounded-xl bg-card px-3 py-1.5 text-sm font-semibold text-success">
          ✓ Correct
        </p>
      );
    if (event.kind === "mismatch")
      return (
        <section class="w-full max-w-[320px] rounded-2xl bg-card px-4 py-3 shadow-sm">
          <h3 class="text-sm font-semibold text-destructive-text">Incorrect. Try again.</h3>
          <p class="mt-1 text-sm text-muted-foreground">You said “{event.transcript}”</p>
        </section>
      );
    if (event.kind === "unintelligible")
      return (
        <p class="w-full max-w-[320px] rounded-2xl bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          Please record that line again.
        </p>
      );
    if (event.kind === "grading-failure")
      return (
        <p class="w-full max-w-[320px] rounded-2xl bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm" role="alert">
          The grading service is unavailable. Try again.
        </p>
      );
    if (event.kind === "result") return <ResultBubble {...event} />;
    if (event.kind === "song-details") return <SongDetailsBubble {...event} />;
    if (event.kind === "language-picker") return <LanguagePicker />;
    if (event.kind === "language-confirmation")
      return (
        <p
          class="w-fit rounded-2xl bg-card px-4 py-2.5 text-sm text-muted-foreground"
          dir={event.language === "ar" ? "rtl" : "ltr"}
        >
          {event.language === "ar" ? "تم اختيار العربية." : "English selected."}
        </p>
      );
    if (event.kind === "choose-open-lesson")
      return (
        <section class="w-full max-w-[320px] overflow-hidden rounded-2xl bg-card shadow-sm">
          <h3 class="p-3.5 text-base font-semibold text-foreground">Which song?</h3>
          <For each={event.songIds}>
            {(songId) => (
              <button
                type="button"
                class="block w-full border-t border-border-soft px-4 py-3 text-center text-sm font-semibold text-primary-text hover:bg-card-hover"
                onClick={() => openSongDetails(songId)}
              >
                {telegramTrialSong(songId).title}
              </button>
            )}
          </For>
        </section>
      );
    return (
      <section class="w-full max-w-[320px] overflow-hidden rounded-2xl bg-card shadow-sm">
        <h3 class="p-4 text-xl font-semibold leading-7 text-foreground">Account connected</h3>
        <button
          type="button"
          class="w-full border-t border-border-soft px-4 py-3 text-sm font-semibold text-primary-text hover:bg-card-hover"
          onClick={chooseAnotherSong}
        >
          Choose another song
        </button>
      </section>
    );
  }

  function SongPicker() {
    const pageCount = Math.ceil(orderedSongs().length / pageSize);
    return (
      <section
        class="w-full max-w-[340px] overflow-hidden rounded-2xl bg-card shadow-sm"
        role="group"
        aria-label="Songs"
        data-telegram-song-picker
        data-picker-page={pickerPage()}
      >
        <div class="p-3.5">
          <h2 class="text-base font-semibold text-foreground">Songs</h2>
          <p class="mt-1 text-sm leading-5 text-muted-foreground">
            Choose a song. Listen to a line, then say it back in English.
          </p>
        </div>
        <For each={visibleSongs()}>
          {(song) => {
            const open = () => unfinishedLessons().some((lesson) => lesson.songId === song.id);
            return (
              <button
                type="button"
                class="block w-full border-t border-border-soft px-4 py-3 text-center text-sm font-semibold text-primary-text transition-colors hover:bg-card-hover"
                onClick={() => selectSong(song.id)}
              >
                {song.title}{open() ? " · Resume" : ""}
              </button>
            );
          }}
        </For>
        <Show when={pageCount > 1}>
          <button
            type="button"
            class="block w-full border-t border-border-soft px-4 py-3 text-center text-sm font-semibold text-primary-text transition-colors hover:bg-card-hover"
            onClick={() => setPickerPage((page) => (page + 1 >= pageCount ? 0 : page + 1))}
          >
            {pickerPage() + 1 >= pageCount ? "Back" : `Next (${nextPageCount()})`}
          </button>
        </Show>
      </section>
    );
  }

  function TelegramPhone() {
    return (
      <div class="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-background text-foreground shadow-xl sm:h-[844px] sm:border-x sm:border-border-soft">
        <div class="flex items-center justify-between px-6 pb-2 pt-5 text-sm font-semibold" aria-hidden="true">
          <span>9:41</span>
          <span class="flex items-center gap-1.5">
            <span class="inline-block h-2.5 w-4 rounded-sm border border-current" />
            <span class="inline-block h-2 w-2 rounded-full bg-current" />
          </span>
        </div>
        <header class="flex h-14 items-center justify-between border-b border-border-soft bg-sidebar px-3">
          <span class="w-20 text-sm text-primary-text">‹ Chats</span>
          <div class="text-center">
            <h1 class="text-base font-semibold leading-5">{TELEGRAM_TRIAL_COMMUNITY_NAME}</h1>
            <p class="text-xs text-muted-foreground">bot</p>
          </div>
          <span class="flex size-9 items-center justify-center rounded-full bg-secondary text-xs font-semibold">NS</span>
        </header>
        <Show when={unfinishedLessons().length > 0}>
          <button
            type="button"
            class="flex w-full items-center gap-2 border-b border-border-soft px-3 py-1.5 text-left text-xs text-muted-foreground"
            onClick={returnToSongPicker}
          >
            <span class="h-7 w-0.5 rounded bg-primary-text" aria-hidden="true" />
            <span>Pinned message</span>
            <span class="font-medium text-foreground">Songs</span>
          </button>
        </Show>
        <div
          class="flex flex-1 flex-col items-start gap-2.5 overflow-y-auto px-3 py-4 [&>*]:shrink-0"
          ref={(element) => {
            scrollRegion = element;
          }}
        >
          <div class="self-end rounded-2xl rounded-br-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            /start
          </div>
          <Show when={unfinishedLessons().length > 0}>
            <span class="self-center rounded-full border border-border bg-background px-3 py-0.5 text-xs text-muted-foreground">Today</span>
          </Show>
          <SongPicker />
          <For each={events()}>{(event) => <EventView event={event} />}</For>
        </div>
        <Show when={recordingOpen()}>
          <div class="border-t border-border-soft bg-popover px-3 py-2" role="group" aria-label="Fixture recording">
            <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fixture recording</p>
            <div class="mt-2 grid gap-1">
              <For each={boundary.speechOptions()}>
                {(submission) => (
                  <button
                    type="button"
                    class="rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-card-hover"
                    onClick={() => submitSpeech(submission)}
                  >
                    {submission.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={menuOpen()}>
          <div class="mx-3 mb-2 overflow-hidden rounded-xl border border-border-soft bg-card shadow-md">
            <button
              type="button"
              class="block w-full px-4 py-3 text-left text-sm hover:bg-card-hover"
              onClick={invokeSongControl}
            >
              <span class="font-semibold text-primary-text">/song</span>{" "}
              <span class="text-muted-foreground">Full song & details</span>
            </button>
            <button
              type="button"
              class="block w-full border-t border-border-soft px-4 py-3 text-left text-sm hover:bg-card-hover"
              onClick={invokeLanguageControl}
            >
              <span class="font-semibold text-primary-text">/language</span>{" "}
              <span class="text-muted-foreground">Language</span>
            </button>
          </div>
        </Show>
        <footer class="flex items-center gap-3 border-t border-border-soft bg-sidebar px-3 pb-6 pt-2">
          <button
            type="button"
            class="rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-primary-text"
            aria-expanded={menuOpen() ? "true" : "false"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
          <div class="min-h-10 flex-1 rounded-full bg-input/40 px-4 py-2 text-sm text-foreground" aria-hidden="true">
            Message
          </div>
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-full text-primary-text disabled:text-muted-foreground"
            aria-label="Record line"
            disabled={!activeLesson() || pendingGrading() !== null}
            onClick={() => setRecordingOpen((open) => !open)}
          >
            <IconMicrophone class="size-6" />
          </button>
        </footer>
      </div>
    );
  }

  function WebsiteConfirmation(props2: { state: WebsiteState }) {
    const state = () => props2.state;
    const confirmation = () => {
      const current = state();
      return current.kind === "confirmation" ? current : null;
    };
    const connectionResult = () => {
      const current = state();
      return current.kind === "checking" || current.kind === "failed" ? current : null;
    };
    return (
      <div class="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-background text-foreground shadow-xl sm:h-[844px] sm:border-x sm:border-border-soft">
        <div class="flex items-center justify-between px-6 pb-2 pt-5 text-sm font-semibold" aria-hidden="true">
          <span>9:41</span>
          <span class="inline-block h-2.5 w-4 rounded-sm border border-current" />
        </div>
        <div class="border-b border-border-soft px-4 py-2">
          <div class="rounded-lg bg-secondary px-4 py-2 text-center text-xs text-foreground">
            nightshift.example/connect
          </div>
        </div>
        <div class="flex flex-1 flex-col justify-center px-6 py-10">
          <Show when={state().kind === "signed-out"}>
            <p class="text-sm font-semibold text-primary-text">{TELEGRAM_TRIAL_COMMUNITY_NAME}</p>
            <h1 class="mt-2 text-3xl font-bold tracking-tight">Connect account</h1>
            <p class="mt-5 text-sm leading-6 text-muted-foreground">
              Sign in to confirm this guest result.
            </p>
            <Button class="mt-6" disabled={websiteBusy()} onClick={() => websiteSignIn("initial")}>
              Sign in
            </Button>
          </Show>
          <Show when={confirmation()}>
            {(confirmation) => (
              <>
                <p class="text-sm font-semibold text-primary-text">{TELEGRAM_TRIAL_COMMUNITY_NAME}</p>
                <h1 class="mt-2 text-3xl font-bold tracking-tight">Connect account</h1>
                <div class="mt-6 rounded-xl border border-border-soft bg-card p-4">
                  <p class="text-xs text-muted-foreground">Signed in as</p>
                  <p class="mt-1 text-base font-semibold">
                    {confirmation().account.shortAddress}
                  </p>
                </div>
                <p class="mt-6 text-base leading-7">{accountExplanation}</p>
                <Button class="mt-6" disabled={websiteBusy()} onClick={confirmWebsiteAccount}>
                  Connect account
                </Button>
                <button
                  type="button"
                  class="mt-4 text-sm font-medium text-primary-text"
                  disabled={websiteBusy()}
                  onClick={() => websiteSignIn("replacement")}
                >
                  Use a different account
                </button>
              </>
            )}
          </Show>
          <Show when={connectionResult()}>
            {(result) => (
              <TelegramConnectionResult
                state={result().kind}
                error={(() => { const current = result(); return current.kind === "failed" ? current.error : undefined; })()}
                onReturn={() => setWebsite(null)}
                onRetry={confirmWebsiteAccount}
              />
            )}
          </Show>
        </div>
      </div>
    );
  }

  return (
    <main class="min-h-dvh bg-background text-foreground" data-telegram-guest-trial>
      <h1 class="sr-only">Telegram guest trial preview</h1>
      <Show when={website()} fallback={<TelegramPhone />}>
        {(state) => <WebsiteConfirmation state={state()} />}
      </Show>
    </main>
  );
}
