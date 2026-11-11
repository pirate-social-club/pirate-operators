import { danceTargetKey, type DanceScope } from "./ports.ts";
export interface DanceCaptureLease {
  assertCurrent(): void;
  /** Revoke this handle immediately; resolve only after native request completion. */
  release(): Promise<void>;
}
/** c7's synchronous cross-tab capture claim becomes a held Web Lock with the
 * async IndexedDB journal. A second tab cannot admit another camera/take for
 * the same frozen resource. This never grants server/chain authority. */
export async function claimBrowserDanceCapture(
  scope: DanceScope,
  current: () => boolean,
): Promise<DanceCaptureLease> {
  if (typeof navigator === "undefined" || !navigator.locks)
    throw Error("dance_recording_lock_unavailable");
  if (!current()) throw Error("dance_session_changed");
  return new Promise<DanceCaptureLease>((resolve, reject) => {
    let release!: () => void,
      live = false;
    const finished = new Promise<void>((done) => {
      release = done;
    });
    const request: Promise<void> = navigator.locks.request(
      "dance-source-capture:" + danceTargetKey(scope),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) throw Error("dance_recording_busy");
        if (!current()) throw Error("dance_session_changed");
        live = true;
        resolve({
          assertCurrent: () => {
            if (!live || !current())
              throw Error("dance_preparation_capture_superseded");
          },
          release: () => {
            live = false;
            release();
            return request;
          },
        });
        await finished;
      },
    );
    void request.catch(reject);
  });
}
