// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-mic-capture-browser.ts; only imports changed.
/**
 * Phase 5.2 — production browser dependency factory for {@link KaraokeMicCapture}.
 *
 * Browser-only: references `navigator`, `AudioContext`, and `AudioWorkletNode`,
 * which do not exist under bun, so this file is NOT unit-tested. It is the real
 * implementation of the injected `deps` the engine consumes. The context uses the
 * hardware-native sample rate (forcing 16 kHz makes the mic source emit silence);
 * the engine reads the ACTUAL `context.sampleRate` and the DSP resamples to 16 kHz.
 *
 * NOTE (audit F6): this still needs a real-browser smoke test + the Vite worklet
 * build wiring verified — neither can run in this (headless/bun) environment.
 */

import type { KaraokeMicCaptureDeps, MicAudioContext } from "../../../../packages/karaoke/mic-capture.ts";

const WORKLET_PROCESSOR_NAME = "karaoke-capture-processor";

/**
 * @param workletModuleUrl built URL of `karaoke-capture-processor.ts`, e.g.
 *   `new URL("./karaoke-capture-processor.ts", import.meta.url)` (Vite bundles it).
 */
const loadedModules = new WeakMap<AudioContext, Promise<void>>();

export function createBrowserMicCaptureDeps(workletModuleUrl: URL | string, sharedContext?: () => AudioContext): KaraokeMicCaptureDeps {
  return {
    addWorkletModule: (context) => {
      const audioContext = context as unknown as AudioContext;
      let loaded = loadedModules.get(audioContext);
      if (!loaded) {
        loaded = audioContext.audioWorklet.addModule(typeof workletModuleUrl === "string" ? workletModuleUrl : workletModuleUrl.href);
        loadedModules.set(audioContext, loaded);
        void loaded.catch(() => loadedModules.delete(audioContext));
      }
      return loaded;
    },
    // Native rate; the worklet resamples microphone input to 16 kHz.
    createContext: () => (sharedContext ? sharedContext() : new AudioContext()) as unknown as MicAudioContext,
    ...(sharedContext ? { releaseContext: async () => {} } : {}),
    createWorkletNode: (context) =>
      new AudioWorkletNode(context as unknown as BaseAudioContext, WORKLET_PROCESSOR_NAME) as unknown as ReturnType<
        KaraokeMicCaptureDeps["createWorkletNode"]
      >,
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints) as unknown as ReturnType<
        KaraokeMicCaptureDeps["getUserMedia"]
      >,
  };
}
