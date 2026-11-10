// Bounded, visible-page observation from DanceReviewPage at the UI provenance
// pin. Only decentralized reads are injected; no command or media is dispatched.
export function createDanceReviewObserver(options: {
  current: () => boolean;
  visible: () => boolean;
  refresh: (reviewId: string) => Promise<void>;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void;
  rested?: () => void;
}) {
  let target: string | null = null;
  let generation = 0;
  let attempts = 0;
  let timer: unknown;
  let disposed = false;
  function stop() {
    if (timer !== undefined) options.cancel(timer);
    timer = undefined;
  }
  function schedule(delay = 3000) {
    stop();
    if (disposed || !target || !options.current() || !options.visible()) return;
    if (attempts >= 90) {
      options.rested?.();
      return;
    }
    const expected = generation;
    timer = options.schedule(() => {
      timer = undefined;
      void refresh(expected);
    }, delay);
  }
  async function refresh(expected: number) {
    const id = target;
    if (
      disposed ||
      !id ||
      expected !== generation ||
      !options.current() ||
      !options.visible()
    )
      return;
    attempts++;
    try {
      await options.refresh(id);
    } catch {
      // The host keeps the confirmed view and projects its read error.
    } finally {
      if (expected === generation) schedule();
    }
  }
  return {
    update(id: string | null) {
      if (target === id) return;
      stop();
      generation++;
      attempts = 0;
      target = id;
      schedule();
    },
    visibilityChanged() {
      stop();
      generation++;
      attempts = 0;
      if (options.visible()) schedule(0);
    },
    dispose() {
      disposed = true;
      target = null;
      generation++;
      stop();
    },
  };
}
