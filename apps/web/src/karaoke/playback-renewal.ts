// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-playback-renewal.ts; see docs/karaoke-learner-handoff.md.
export interface KaraokePlaybackGrant {
  url: string;
  expiresAtMs: number;
  renewAtMs: number;
}

export interface KaraokePlaybackAccess {
  grant: KaraokePlaybackGrant;
  renew: (signal: AbortSignal) => Promise<KaraokePlaybackGrant>;
}

/** Keeps one media element and one scored take across short-lived grants. */
export function createKaraokePlaybackRenewal(options: {
  access: KaraokePlaybackAccess;
  audio: () => HTMLAudioElement | undefined;
  canResume: () => boolean;
  onPause: (songMs: number) => void | Promise<void>;
  onIssue: (issue: boolean) => void;
}) {
  let grant = options.access.grant;
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoreAt: number | undefined;
  let resumeWhenReady = false;
  let loading = false;
  let mediaFailed = false;
  let disposed = false;
  let playGeneration = 0;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const pause = () => {
    const audio = options.audio();
    if (!audio) return;
    audio.pause();
    return options.onPause((restoreAt ?? audio.currentTime) * 1000);
  };
  const playCurrent = () => {
    const audio = options.audio();
    if (!audio || disposed || !options.canResume()) return;
    const generation = ++playGeneration;
    options.onIssue(false);
    void audio.play().catch(() => {
      if (disposed || generation !== playGeneration || !options.canResume()) return;
      pause();
      options.onIssue(true);
    });
  };
  const load = async (refreshGrant: boolean) => {
    if (pending || disposed) return;
    playGeneration += 1;
    clearTimer();
    const audio = options.audio();
    if (!audio) return;
    const songTime = restoreAt ?? audio.currentTime;
    restoreAt = songTime;
    const suspended = pause();
    options.onIssue(false);
    const controller = new AbortController();
    pending = controller;
    try {
      const next = refreshGrant ? await options.access.renew(controller.signal) : grant;
      // Changing src resets physical media time. Keep it stable until all
      // captured PCM from the old grant has been flushed through its anchor.
      await suspended;
      if (disposed || pending !== controller || controller.signal.aborted) return;
      if (next.renewAtMs <= Date.now() || next.expiresAtMs <= next.renewAtMs) {
        throw new Error("Karaoke playback access has expired");
      }
      grant = next;
      restoreAt = songTime;
      loading = true;
      mediaFailed = false;
      audio.src = next.url;
      audio.load();
    } catch {
      if (!disposed && pending === controller && !controller.signal.aborted) {
        // Keep the take paused. Retry repeats access authorization, never session creation.
        resumeWhenReady = false;
        options.onIssue(true);
      }
    } finally {
      if (pending === controller) pending = undefined;
    }
  };
  const play = () => {
    if (disposed) return;
    resumeWhenReady = true;
    if (pending || loading || !options.canResume()) return;
    if (Date.now() >= grant.renewAtMs) void load(true);
    else if (mediaFailed) void load(false);
    else { resumeWhenReady = false; playCurrent(); }
  };
  const resume = () => { if (resumeWhenReady) play(); };
  const cancel = () => {
    playGeneration += 1;
    clearTimer();
    pending?.abort();
    pending = undefined;
    restoreAt = undefined;
    resumeWhenReady = false;
    loading = false;
    mediaFailed = false;
  };
  return {
    play,
    cancel,
    resume,
    // An AudioContext interruption requires an explicit gesture even if a
    // renewal is still loading. A transient scoring reconnect does not.
    interrupt: () => { resumeWhenReady = false; },
    positionSeconds: () => restoreAt,
    playing: () => {
      if (disposed) return false;
      if (Date.now() >= grant.renewAtMs) { play(); return false; }
      clearTimer();
      timer = setTimeout(() => {
        if (!options.audio()?.paused && options.canResume()) play();
      }, Math.max(1, grant.renewAtMs - Date.now()));
      return true;
    },
    metadata: () => {
      const audio = options.audio();
      if (!audio || disposed || !loading || restoreAt === undefined) return;
      audio.currentTime = Number.isFinite(audio.duration)
        ? Math.min(restoreAt, Math.max(0, audio.duration)) : restoreAt;
      restoreAt = undefined;
      loading = false;
      resume();
    },
    error: () => {
      const audio = options.audio();
      if (!audio || disposed) return;
      playGeneration += 1;
      clearTimer();
      restoreAt ??= audio.currentTime;
      loading = false;
      mediaFailed = true;
      resumeWhenReady = false;
      pause();
      options.onIssue(true);
    },
    dispose: () => { disposed = true; cancel(); },
  };
}
