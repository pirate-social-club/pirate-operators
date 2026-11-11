/** Local media preparation only; upload/provider commands have their own lifecycle. */
export const VIDEO_DURATION_TIMEOUT_MS = 10_000;
export const VIDEO_FINALIZATION_TIMEOUT_MS = 30_000;
export const VIDEO_PREPARATION_TIMEOUT_NOTICE =
  "The recording couldn’t finish. Record again.";

export class VideoPreparationDeadlineError extends Error {
  constructor() {
    super(VIDEO_PREPARATION_TIMEOUT_NOTICE);
    this.name = "VideoPreparationDeadlineError";
  }
}

/** Signals cancellation and bounds the caller even if an adapter cannot abort.
 * Callers must check the signal after awaits before committing UI state. */
export async function withVideoPreparationDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(new VideoPreparationDeadlineError()),
    timeoutMs,
  );
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
