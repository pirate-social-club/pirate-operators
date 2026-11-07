// Shared settings of the live Karaoke browser journey. The simulated provider
// times the published lyrics quickly, with characters only, so the browser
// sings the whole song in about twenty seconds through the character fallback.
import type { SimulatedAlignment } from "../../../harness/karaoke-elevenlabs-simulator.ts";

export const LIVE_PORT = 4180;
export const LIVE_ALIGNMENT: SimulatedAlignment = {
  mode: "characters",
  startMs: 1500,
  charMs: 10,
  spaceMs: 10,
  lineGapMs: 150,
};
/** Include an instrumental outro after the last scored lyric. */
export const LIVE_STEM_MS = 30000;
