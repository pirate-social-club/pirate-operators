import { ServiceRefusal as ApiClientError } from "../../../service-refusal.ts";
import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";

import {
  Button,
  IconMusicNote,
  Spinner,
  Type,
} from "../../../design-system.ts";
import { PostComposerExcerptSelector } from "./preview-segment-selector.tsx";
import {
  canHoldExcerpt,
  clampExcerpt,
  defaultExcerpt,
  type ExcerptBounds,
  excerptLengthMs,
  isSubmittableExcerpt,
  MIN_EXCERPT_MS,
  windowLengthsMs,
  windowWithLength,
} from "./song-excerpt.ts";
import {
  retainSongExcerpt,
  type SongExcerptDraftStore,
} from "./song-excerpt-draft.ts";
import { parseSongLink } from "./song-excerpt-link.ts";
import { SongPicker, type SongPickerSource } from "./song-picker.tsx";
import {
  loadSongSource,
  type SongSourceReader,
  type SongSourceRequest,
  type SongSourceState,
} from "./song-excerpt-source.ts";
import {
  canonicalTiming,
  type CanonicalSongTiming,
  intervalFromExcerpt,
  type SongChoice,
  type SongIntervalPreflight,
  songPlanFromError,
  songReservationRefusalText,
  songPlanFromPreflight,
  type SongPlanState,
} from "../video-submission/song-reference.ts";

/** Choosing a real song, hearing the part of it the video will use, and
 * keeping that choice with the video draft.
 *
 * The song is named by an ordinary post link, a `/p/<post id>` link or a bare
 * post id. The audio is the song's full mix through the song playback access
 * operation, which needs nothing from Karaoke: lyrics acceptance, alignment or
 * the Karaoke runtime are not preconditions for posting a video to a song.
 * Whether this audio may be rendered into a published video is the server's
 * decision, asked through the preflight below and decided again at
 * reservation; this surface reports that answer and never infers one.
 *
 * The excerpt is one fixed-length window dragged through the song, and its
 * length is the length of the recording that will carry it. Choosing it is
 * enough: the draft is kept automatically and the server is asked on a debounce
 * rather than on a separate retain action. No fixture is ever substituted
 * here: a song that fails to load says so, in every case.
 */
export interface SoundtrackSelection {
  readonly songPostId: string;
  readonly title: string;
  readonly audioUrl: string;
  readonly bounds: ExcerptBounds;
}

export function SongExcerptComposer(props: {
  read: SongSourceReader;
  store: SongExcerptDraftStore;
  communityId?: string;
  personaId?: string;
  preflight?: SongIntervalPreflight;
  disabled?: boolean;
  initialSong?: { readonly postId: string; readonly communityId?: string };
  /** Songs offered in the picker; defaults to the community's songs. */
  songs: SongPickerSource;
  /** Leaves the composer from the song picker, before any song is chosen. */
  onClose?: () => void;
  /** How much song the finished clip can carry, once there is a clip. The
   * window shortens to it from the same start; without a clip it is as long
   * as a video may be. */
  clipLengthMs?: number | null;
  onSelection?: (selection: SoundtrackSelection | null) => void;
  onPlan?: (state: SongPlanState) => void;
  onChoice?: (choice: SongChoice) => void;
  /** Where the song read stands, so a host can title its screen for it. */
  onSource?: (kind: SongSourceState["kind"]) => void;
}) {
  // The store, reader and initial song are captured once, not read per call. A
  // caller writing `store={makeStore()}` passes a prop getter that builds a new
  // store on every access, and the failure is silent: the retain writes into
  // one store and the reopen reads an empty one.
  const store = props.store;
  const reader = props.read;
  const initialSong = props.initialSong;
  const communityId = props.communityId;
  const preflight = communityId === undefined ? undefined : props.preflight;
  const reportPlan = props.onPlan;
  const reportChoice = props.onChoice;
  const reportSelection = props.onSelection;
  const reportSource = props.onSource;

  const [link, setLink] = createSignal("");
  const [linkProblem, setLinkProblem] = createSignal<string>();
  const [source, setSourceState] = createSignal<SongSourceState>({
    kind: "idle",
  });
  const setSource = (next: SongSourceState) => {
    setSourceState(next);
    reportSource?.(next.kind);
  };
  const [durationMs, setDurationMs] = createSignal(0);
  const [bounds, setBounds] = createSignal<ExcerptBounds>({
    startMs: 0,
    endMs: 0,
  });
  const [playing, setPlaying] = createSignal(false);
  const [note, setNote] = createSignal<string>();
  // A payload can read cleanly and still yield audio this browser cannot use: a
  // grant that does not fetch, a container it cannot decode, or a stream whose
  // length is unknown. None of that reaches `loadSongSource`, so the element
  // reports it here and the surface stops waiting.
  const [audioProblem, setAudioProblem] = createSignal<string>();
  // The server's timing for the loaded song, once it has answered. It replaces
  // the element's length as the bound: the element decodes for playback, the
  // server measured the canonical samples the video is rendered from.
  const [timing, setTiming] = createSignal<CanonicalSongTiming>();
  const [plan, setPlanState] = createSignal<SongPlanState>({ kind: "none" });
  const setPlan = (next: SongPlanState) => {
    setPlanState(next);
    reportPlan?.(next);
  };

  let audio: HTMLAudioElement | undefined;
  // Bounds read back from the draft, waiting for a length to be clamped
  // against. Applied by `noteDuration`, because they are only meaningful once
  // the song's length is known.
  let pendingRestore: ExcerptBounds | undefined;
  let pending: AbortController | undefined;
  // The last thing the author asked to load, so a retry asks for the same
  // song rather than trying to reconstruct it from a failed state.
  let lastRequest: SongSourceRequest | undefined;
  // Only the newest load may set state. Aborting the previous one is not
  // enough: a reader that ignores its signal can still resolve late and
  // overwrite the song the person is now looking at.
  let generation = 0;
  // Each check supersedes the one before it, so a late answer about an older
  // excerpt can never become the plan for the current one.
  let check: AbortController | undefined;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  let timingRetry: ReturnType<typeof setTimeout> | undefined;
  let retainTimer: ReturnType<typeof setTimeout> | undefined;
  let planTimer: ReturnType<typeof setTimeout> | undefined;
  const stopPlanCheck = () => {
    if (planTimer !== undefined) clearTimeout(planTimer);
    planTimer = undefined;
    check?.abort();
    check = undefined;
    if (recheck !== undefined) clearTimeout(recheck);
    recheck = undefined;
  };
  const stopChecking = () => {
    stopPlanCheck();
    if (timingRetry !== undefined) clearTimeout(timingRetry);
    timingRetry = undefined;
  };

  // The playhead is watched on animation frames rather than on `timeupdate`,
  // which fires about four times a second and would let the excerpt run up to a
  // quarter second past its end. `timeupdate` stays as a backstop for when
  // frames stop arriving, as they do in a background tab.
  let frame: number | undefined;
  const stopWatching = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const watch = () => {
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!audio || !playing()) return;
      observe(audio.currentTime * 1_000);
      if (playing()) watch();
    });
  };

  /** The excerpt ends where the author said it ends, not where the song does. */
  const observe = (atMs: number) => {
    if (!playing()) return;
    if (atMs < bounds().startMs - 500) {
      stopPlayback();
      setNote(
        "This browser couldn’t start that audio at the chosen point, so nothing was played.",
      );
      return;
    }
    if (atMs >= bounds().endMs) stopPlayback();
  };

  const currentPostId = () => {
    const state = source();
    return state.kind === "ready" ? state.postId : undefined;
  };
  const currentTitle = () => {
    const state = source();
    return state.kind === "ready" ? state.title : undefined;
  };
  const currentAudioUrl = () => {
    const state = source();
    return state.kind === "ready" ? state.audioUrl : undefined;
  };
  /** The length the selection is bounded by: the server's when known, and
   * otherwise the element's. */
  const boundBy = (elementMs: number) => timing()?.durationMs ?? elementMs;
  const lengthMs = () => boundBy(durationMs());

  const stopPlayback = () => {
    stopWatching();
    audio?.pause();
    setPlaying(false);
  };

  onCleanup(() => {
    stopWatching();
    stopChecking();
    if (retainTimer !== undefined) clearTimeout(retainTimer);
    audio?.pause();
    pending?.abort();
  });

  /** The server's timing for a song, asked before any excerpt is chosen. A
   * song-level refusal (not available yet, not permitted, unmeasurable) is
   * shown straight away; a failed read falls back to the element's length and
   * the check at retain time asks again. */
  const requestTiming = async (
    songPostId: string,
    mine: number,
    attempt = 0,
  ) => {
    if (!preflight || communityId === undefined) return;
    try {
      const response = await preflight(
        { path: { communityId }, body: { song_post_id: songPostId } },
        pending?.signal,
      );
      if (mine !== generation) return;
      const known = canonicalTiming(response);
      if (known) {
        setTiming(known);
        setBounds((current) =>
          current.endMs > 0 ? clampExcerpt(current, known.durationMs) : current,
        );
        return;
      }
      if (response.state === "unavailable")
        setPlan({ kind: "timing_unavailable" });
      else if (response.state === "measuring" && attempt < 30) {
        timingRetry = setTimeout(
          () => void requestTiming(songPostId, mine, attempt + 1),
          response.retry_after_ms,
        );
      }
    } catch (failure) {
      if (mine !== generation || !(failure instanceof ApiClientError)) return;
      const state = songPlanFromError(failure);
      if (
        state.kind === "not_available" ||
        state.kind === "ineligible" ||
        state.kind === "timing_unavailable"
      ) {
        setPlan(state);
      }
    }
  };

  /** Asks whether the current excerpt can back this video. Called on a
   * debounce as the window moves, so dragging does not send a request per
   * frame; the answer still belongs to the newest window only. */
  const checkPlan = async (
    songPostId: string,
    chosen: ExcerptBounds,
    attempt = 0,
  ) => {
    if (!preflight || communityId === undefined) return;
    stopPlanCheck();
    const controller = new AbortController();
    check = controller;
    setPlan({ kind: "checking" });
    let next: SongPlanState;
    try {
      const response = await preflight(
        {
          path: { communityId },
          body: {
            song_post_id: songPostId,
            interval: intervalFromExcerpt(chosen),
          },
        },
        controller.signal,
      );
      next = songPlanFromPreflight(response, { songPostId, bounds: chosen });
      const known = canonicalTiming(response);
      if (known && check === controller) setTiming(known);
    } catch (failure) {
      if (controller.signal.aborted) return;
      next =
        failure instanceof ApiClientError
          ? songPlanFromError(failure)
          : { kind: "failed", retryable: true };
    }
    if (check !== controller) return;
    check = undefined;
    setPlan(next);
    // A song still being measured is asked again, for about a minute at the
    // server's suggested pace, and then left for the author to retry.
    if (next.kind === "measuring" && attempt < 30) {
      recheck = setTimeout(
        () => void checkPlan(songPostId, chosen, attempt + 1),
        next.retryAfterMs,
      );
    }
  };

  const scheduleCheck = (songPostId: string, chosen: ExcerptBounds) => {
    if (planTimer !== undefined) clearTimeout(planTimer);
    planTimer = setTimeout(() => {
      planTimer = undefined;
      void checkPlan(songPostId, chosen);
    }, 350);
  };

  /** The selection is kept automatically, on the same debounce: the author
   * chose it, and a separate retain action was a draft-store concept they
   * should not have to know. */
  const scheduleRetain = (songPostId: string, chosen: ExcerptBounds) => {
    if (retainTimer !== undefined) clearTimeout(retainTimer);
    retainTimer = setTimeout(() => {
      retainTimer = undefined;
      void retainSongExcerpt(store, songPostId, chosen).catch(() => undefined);
    }, 400);
  };

  const applyWindow = (next: ExcerptBounds, songPostId: string) => {
    setBounds(next);
    // The previous approval belongs to the previous window. It is invalidated
    // now, not when the debounce fires: publishing in between must not submit
    // an interval the author has already moved away from, and an answer still
    // in flight for the old window must not become the plan.
    if (preflight && communityId !== undefined) {
      stopPlanCheck();
      setPlan({ kind: "checking" });
    }
    const title = currentTitle();
    const audioUrl = currentAudioUrl();
    if (title !== undefined && audioUrl !== undefined) {
      reportSelection?.({ songPostId, title, audioUrl, bounds: next });
    }
    scheduleRetain(songPostId, next);
    scheduleCheck(songPostId, next);
    if (audio && playing()) {
      const atMs = audio.currentTime * 1_000;
      if (atMs < next.startMs || atMs >= next.endMs)
        audio.currentTime = next.startMs / 1_000;
    }
  };

  /** The window's length: as long as a video may be, until a shorter clip
   * says how much of the song it uses. The author only chooses the start. */
  const wantedLengthMs = () => {
    const longest = windowLengthsMs(lengthMs(), timing() ?? {})[0] ?? 0;
    const clip = props.clipLengthMs;
    return clip === undefined || clip === null
      ? longest
      : Math.min(longest, Math.max(MIN_EXCERPT_MS, Math.floor(clip)));
  };
  const readySong = () => {
    const state = source();
    return state.kind === "ready" ? state : undefined;
  };
  createEffect(
    () => ({ want: wantedLengthMs(), ready: readySong(), current: bounds() }),
    ({ want, ready, current }) => {
      if (
        !ready ||
        want <= 0 ||
        excerptLengthMs(current) <= 0 ||
        excerptLengthMs(current) === want
      )
        return;
      // Written outside the effect's owned scope, as Solid requires.
      queueMicrotask(() => {
        const song = readySong();
        if (song?.postId !== ready.postId || excerptLengthMs(bounds()) === want)
          return;
        applyWindow(windowWithLength(bounds(), want, lengthMs()), ready.postId);
      });
    },
  );

  const resetSong = () => {
    stopPlayback();
    stopChecking();
    if (retainTimer !== undefined) clearTimeout(retainTimer);
    setNote(undefined);
    setAudioProblem(undefined);
    setTiming(undefined);
    setPlan({ kind: "none" });
    setSource({ kind: "idle" });
    setDurationMs(0);
    setBounds({ startMs: 0, endMs: 0 });
    setLink("");
    setLinkProblem(undefined);
    reportSelection?.(null);
    reportChoice?.({ kind: "none" });
  };

  const loadSong = async (request: SongSourceRequest) => {
    lastRequest = request;
    stopPlayback();
    stopChecking();
    if (retainTimer !== undefined) clearTimeout(retainTimer);
    setNote(undefined);
    setAudioProblem(undefined);
    setTiming(undefined);
    setPlan({ kind: "none" });
    setDurationMs(0);
    setBounds({ startMs: 0, endMs: 0 });
    reportSelection?.(null);
    pending?.abort();
    pending = new AbortController();
    const mine = ++generation;
    setSource({ kind: "loading" });
    // Loading a valid song link is the author's choice, made before the reader
    // answers. A pending or failed read keeps that choice.
    if (request.kind === "post")
      reportChoice?.({ kind: "song", songPostId: request.postId });
    const next = await loadSongSource(request, reader, pending.signal);
    if (mine !== generation) return;
    setSource(next);
    if (next.kind === "ready") {
      reportChoice?.({ kind: "song", songPostId: next.postId });
      void requestTiming(next.postId, mine);
      // Reopening the draft should not need a second action: if this song
      // already has a retained excerpt, it comes back with the song. The
      // bounds are applied once a length is known, which is why they are held
      // here rather than written straight into the selector.
      const held = await store.load();
      if (mine === generation && held?.songPostId === next.postId) {
        pendingRestore = { endMs: held.endMs, startMs: held.startMs };
      }
    }
  };

  // The value is passed in rather than re-read from the signal: a write is
  // not visible to a same-tick read under the current signals runtime, so
  // the just-pasted link would parse as empty.
  const submitLink = (pending?: string) => {
    const parsed = parseSongLink(pending ?? link());
    if (parsed.kind === "unsupported") {
      setLinkProblem(parsed.reason);
      return;
    }
    setLinkProblem(undefined);
    void loadSong(parsed);
  };

  // Entering from a song post loads that song once, without a paste step, and
  // only after the first render, so a server render never starts the read.
  onSettled(() => {
    if (initialSong)
      void loadSong({
        kind: "post",
        postId: initialSong.postId,
        ...(initialSong.communityId === undefined
          ? {}
          : { communityId: initialSong.communityId }),
      });
  });

  /** The length comes from the audio element, not from the payload: the element
   * is the thing that will play, so its own idea of the length is the one the
   * bounds have to respect.
   *
   * Once metadata has loaded, a length that is not a positive finite number is
   * final rather than pending — a live or unbounded stream reports `Infinity`
   * and never improves — so it is reported as unusable instead of leaving the
   * surface waiting for a number that is not coming. */
  const noteDuration = (seconds: number, settled: boolean) => {
    const total = Math.round(seconds * 1_000);
    if (Number.isFinite(total) && total > 0) {
      setAudioProblem(undefined);
      setDurationMs(total);
      const held = pendingRestore;
      pendingRestore = undefined;
      // From the value just reported, not from the signal set above: a write is
      // not readable until the update it belongs to has been applied.
      const length = boundBy(total);
      const songPostId = currentPostId() ?? "";
      if (held) {
        const restored = clampExcerpt(held, length);
        if (isSubmittableExcerpt(restored, length)) {
          applyWindow(restored, songPostId);
          return;
        }
      }
      // From the values just computed, not from a signal read after a write:
      // a write is not readable until the update it belongs to has been
      // applied, and reading the stale bounds here sent an empty interval.
      const current = bounds();
      const next =
        current.endMs > 0
          ? clampExcerpt(current, length)
          : defaultExcerpt(length);
      setBounds(next);
      const title = currentTitle();
      const audioUrl = currentAudioUrl();
      if (title !== undefined && audioUrl !== undefined) {
        reportSelection?.({ songPostId, title, audioUrl, bounds: next });
      }
      if (songPostId) {
        scheduleRetain(songPostId, next);
        scheduleCheck(songPostId, next);
      }
      return;
    }
    if (settled) {
      setDurationMs(0);
      setAudioProblem("This song’s length couldn’t load.");
    }
  };

  /** The element could not fetch or decode the source at all. */
  const noteAudioFailure = () => {
    stopPlayback();
    setDurationMs(0);
    setAudioProblem(
      "That audio couldn’t be played in this browser. It may have moved or expired.",
    );
  };

  const togglePlayback = () => {
    if (!audio) return;
    if (playing()) {
      stopPlayback();
      return;
    }
    audio.currentTime = bounds().startMs / 1_000;
    setPlaying(true);
    watch();
    void audio.play().catch(() => {
      // Autoplay refusal and a decode failure both land here, and neither is
      // something to report as playing.
      stopWatching();
      setPlaying(false);
      setNote("That audio would not play in this browser.");
    });
  };

  /** The status line, in the words an author acts on. A chosen song with no
   * verdict yet is not the same as no song at all: publishing waits for the
   * server's answer. */
  const planText = () => {
    const current = plan();
    switch (current.kind) {
      case "none":
        return undefined;
      case "checking":
        return undefined;
      case "not_available":
        return "Posting a video to a song isn’t available yet.";
      case "measuring":
        return "Getting this song ready…";
      case "timing_unavailable":
        return "This song’s length couldn’t load.";
      case "refused":
        return songReservationRefusalText(current.reason);
      case "ineligible":
        return songReservationRefusalText(current.reasonCode);
      case "failed":
        return "Couldn’t use this part of the song.";
      case "ready":
        return undefined;
    }
  };
  /** The plan message shows only what the author can act on: a refusal, a
   * failure, a song that cannot be measured. A pending check is machinery —
   * moving the scrubber fires one on every adjustment — and surfaces only on
   * the confirm action, never as ambient text. */
  const showPlanMessage = () =>
    !preflight || !["none", "checking", "ready"].includes(plan().kind);

  const readyOf = (state: SongSourceState) =>
    state.kind === "ready" ? state : undefined;
  const problemOf = (state: SongSourceState): string | undefined =>
    state.kind === "unavailable" ||
    state.kind === "error" ||
    state.kind === "restricted"
      ? state.reason
      : undefined;
  /** Whether loading again could plausibly give a different answer. */
  const retryableProblem = (state: SongSourceState): boolean =>
    (state.kind === "unavailable" || state.kind === "error") && state.retryable;

  const requiresAnotherSong = () => {
    const current = plan();
    return (
      (current.kind === "ineligible" &&
        current.reasonCode !== "song_owner_policy_unavailable") ||
      (current.kind === "refused" &&
        (current.reason === "interval_too_long" ||
          current.reason === "interval_too_short"))
    );
  };

  const canRetryPlan = () => {
    const current = plan();
    return (
      current.kind === "failed" ||
      (current.kind === "ineligible" &&
        current.reasonCode === "song_owner_policy_unavailable")
    );
  };

  return (
    <section class="grid min-w-0 grid-cols-1 gap-3" aria-label="Song excerpt">
      <Show when={source().kind === "idle"}>
        <SongPicker
          communityId={communityId}
          personaId={props.personaId}
          linkProblem={linkProblem()}
          onLink={(value) => {
            setLink(value);
            submitLink(value);
          }}
          onPick={(postId) => {
            setLinkProblem(undefined);
            void loadSong({ kind: "post", postId });
          }}
          onClose={props.onClose}
          preview={async (postId, signal) =>
            (await reader({ kind: "post", postId }, signal)).audioUrl
          }
          source={props.songs}
        />
      </Show>

      <Show when={source().kind === "loading"}>
        <div class="grid min-h-48 place-items-center">
          <Spinner label="Loading song" />
        </div>
      </Show>
      <Show when={problemOf(source())}>
        {(reason) => (
          <div class="grid gap-2">
            <Type as="p" variant="caption" role="alert">
              {reason()}
            </Type>
            <div class="flex gap-2">
              <Show when={retryableProblem(source()) && lastRequest}>
                <Button
                  onClick={() => {
                    if (lastRequest) void loadSong(lastRequest);
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Try again
                </Button>
              </Show>
              <Button
                onClick={resetSong}
                type="button"
                variant={retryableProblem(source()) ? "secondary" : "default"}
              >
                Change song
              </Button>
            </div>
          </div>
        )}
      </Show>

      <Show when={readyOf(source())}>
        {(ready) => (
          <>
            <audio
              onDurationChange={(event) =>
                noteDuration(event.currentTarget.duration, false)
              }
              onEnded={() => stopPlayback()}
              onError={() => noteAudioFailure()}
              onLoadedMetadata={(event) =>
                noteDuration(event.currentTarget.duration, true)
              }
              onTimeUpdate={(event) =>
                observe(event.currentTarget.currentTime * 1_000)
              }
              preload="metadata"
              ref={(element) => {
                audio = element;
              }}
              src={ready().audioUrl}
            />
            <div class="grid min-w-0 grid-cols-1 gap-1">
              <div class="flex min-w-0 items-center gap-3">
                <span class="grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] bg-muted">
                  <IconMusicNote aria-hidden="true" class="size-5" />
                </span>
                <Type
                  as="p"
                  class="min-w-0 flex-1 truncate"
                  variant="body-strong"
                >
                  {ready().title}
                </Type>
                <Show when={!requiresAnotherSong() && !audioProblem()}>
                  <Button
                    class="shrink-0"
                    onClick={resetSong}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Change
                  </Button>
                </Show>
              </div>
              <Show when={audioProblem()}>
                {(problem) => (
                  <>
                    <Type as="p" variant="caption" role="alert">
                      {problem()}
                    </Type>
                    <Button
                      class="justify-self-start"
                      onClick={resetSong}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Change song
                    </Button>
                  </>
                )}
              </Show>
              {/* A loaded song whose length is not known yet has nothing to
                  choose from, and Continue stays disabled: say so, unless the
                  plan line below already does. */}
              <Show
                when={
                  !audioProblem() &&
                  lengthMs() === 0 &&
                  plan().kind !== "measuring"
                }
              >
                <Spinner label="Preparing song" />
              </Show>
              <Show
                when={
                  !audioProblem() &&
                  lengthMs() > 0 &&
                  !canHoldExcerpt(lengthMs())
                }
              >
                <Type as="p" variant="caption">
                  Choose a song at least 3 seconds long.
                </Type>
              </Show>
            </div>

            <Show
              when={
                !requiresAnotherSong() &&
                !audioProblem() &&
                lengthMs() > 0 &&
                canHoldExcerpt(lengthMs())
              }
            >
              <PostComposerExcerptSelector
                bounds={bounds()}
                disabled={props.disabled}
                onChange={(next) => applyWindow(next, ready().postId)}
                onTogglePreview={togglePlayback}
                playing={playing()}
                songDurationMs={lengthMs()}
              />
            </Show>

            <div
              class={
                showPlanMessage()
                  ? "flex items-center gap-3 text-muted-foreground"
                  : "hidden"
              }
              data-song-plan={preflight ? plan().kind : "unchecked"}
            >
              <Show when={showPlanMessage()}>
                <Show
                  when={
                    plan().kind === "measuring" || plan().kind === "checking"
                  }
                  fallback={
                    <Type as="p" variant="caption" role="alert">
                      {preflight
                        ? planText()
                        : "Video posts aren’t available right now."}
                    </Type>
                  }
                >
                  <Spinner label="Checking song" />
                </Show>
                <Show when={canRetryPlan() && currentPostId()}>
                  <Button
                    onClick={() => {
                      const id = currentPostId();
                      if (id) void checkPlan(id, bounds());
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Try again
                  </Button>
                </Show>
              </Show>
            </div>
            <Show when={requiresAnotherSong()}>
              <Button
                class="justify-self-start"
                onClick={resetSong}
                type="button"
              >
                Choose another song
              </Button>
            </Show>
            <Show when={note()}>
              {(text) => (
                <Type as="p" variant="caption" role="status">
                  {text()}
                </Type>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
