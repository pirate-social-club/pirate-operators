// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-playback-graph.ts; see docs/karaoke-learner-handoff.md.
export type KaraokePlaybackInterruption = (songMs: number, state: AudioContextState, alreadyPaused: boolean) => void;

/** Playback owns this context; individual takes borrow it and release only their mic graph. */
export class KaraokePlaybackGraph {
  private element: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private hasRun = false;
  private interruptedState: AudioContextState | null = null;
  private readonly pendingResumes = new Set<() => void>();
  private readonly onStateChange = () => this.checkState();

  private readonly createContext: () => AudioContext;
  private readonly onInterrupted?: KaraokePlaybackInterruption;

  // Parameter properties expanded for Node's strip-only TypeScript; behavior unchanged.
  constructor(
    createContext: () => AudioContext = () => new AudioContext(),
    onInterrupted?: KaraokePlaybackInterruption,
  ) {
    this.createContext = createContext;
    this.onInterrupted = onInterrupted;
  }

  attach(element: HTMLAudioElement | null): void {
    if (element === this.element) return;
    this.dispose();
    this.element = element;
  }

  acquire(): AudioContext {
    if (!this.element) throw new Error("Karaoke playback is unavailable");
    if (this.context) return this.context;
    const context = this.createContext();
    try {
      const source = context.createMediaElementSource(this.element);
      source.connect(context.destination);
      this.source = source;
      this.context = context;
      context.addEventListener("statechange", this.onStateChange);
      this.checkState();
      return context;
    } catch (error) {
      void context.close();
      throw error;
    }
  }

  /** Also sampled by the playback clock in case a browser omits the event. */
  checkState(): void {
    if (this.context?.state === "running") {
      this.hasRun = true;
      this.interruptedState = null;
      return;
    }
    if (!this.context || !this.hasRun || !this.element || this.interruptedState === this.context.state) return;
    this.interruptedState = this.context.state;
    const songMs = this.element.currentTime * 1000;
    const alreadyPaused = this.element.paused;
    // Renewal can already have paused media. A new context interruption must
    // still revoke its pending recovery, once per state transition.
    if (!alreadyPaused) this.element.pause();
    this.onInterrupted?.(songMs, this.context.state, alreadyPaused);
  }

  isRunning(): boolean { return this.context?.state === "running"; }

  /** Called directly by the recovery button, before yielding user activation. */
  resume(): Promise<boolean> {
    const context = this.context;
    if (!context || context.state === "closed") return Promise.resolve(false);
    if (context.state === "running") return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (running: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingResumes.delete(cancel);
        resolve(running && this.context === context);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 2000);
      this.pendingResumes.add(cancel);
      try {
        void context.resume().then(() => finish(context.state === "running"), cancel);
      } catch { cancel(); }
    });
  }

  dispose(): void {
    this.context?.removeEventListener("statechange", this.onStateChange);
    this.pendingResumes.forEach(cancel => cancel());
    this.source?.disconnect();
    if (this.context) void this.context.close();
    this.source = null;
    this.context = null;
    this.element = null;
    this.hasRun = false;
    this.interruptedState = null;
  }
}
