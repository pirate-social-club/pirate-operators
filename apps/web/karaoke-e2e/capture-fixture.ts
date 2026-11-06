// Simulated provider script for the live-capture scenario. Word times are on
// the provider's own stream clock, which starts when the first captured chunk
// arrives, so they map to song time through the operator's frame timeline.
import type { SimulatedStream } from "../../../harness/karaoke-elevenlabs-simulator.ts";

/** Covers the first three fixture lines (0 to 7 s) with a short tail. */
export const CAPTURE_TRACK_MS = 8000;
const word = (text: string, startMs: number, endMs: number) => ({
  text,
  start: startMs / 1000,
  end: endMs / 1000,
});
const take: SimulatedStream = {
  words: [
    word("sing", 200, 900),
    word("together", 900, 1600),
    word("hold", 2700, 3200),
    word("the", 3200, 3700),
    word("light", 3700, 4300),
    word("sing", 5200, 5900),
    word("together", 5900, 6600),
  ],
};
/** One provider stream per take; a learner reconnect keeps its take's stream. */
export const captureStreams: SimulatedStream[] = [take, take, take];
export const capturedWords = take.words;
