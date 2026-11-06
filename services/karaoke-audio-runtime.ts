// Operator entry with live Karaoke audio: services/runtime.ts unchanged, with
// its state Durable Object extended to accept audio frames. The coordinator can
// instead fold KaraokeAudioState's dispatch into runtime.ts; see
// docs/karaoke-capture-handoff.md.
export { default } from "./runtime.ts";
export { KaraokeAudioState as ServiceState } from "./karaoke-audio.ts";
