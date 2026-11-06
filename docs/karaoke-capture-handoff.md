# Karaoke capture and live transcription handoff

This branch adds live Karaoke capture: the learner's microphone in the browser,
audio frames on the operator's existing Karaoke socket, and the operator's own
ElevenLabs Scribe v2 realtime connection, whose committed, song-timed words
reach the existing scorer. It is the second slice recorded in the
control-plane task pirate-karaoke-capture-20261106. Its base is the display and
playback slice on feat/karaoke-learner eea9011 (draft PR 28). Every change is a
new file, except updates to this lane's own test compatibility layer
`test/karaoke-expect.ts` and acceptance files from PR 28.

Real song identity, consented LearningRecords publication, segment purchases
from the learner's screen and the alignment character-timing fallback are the
later integration slice, coordinated with the first-song coordinator. No real
provider was called; every test uses a simulated ElevenLabs.

## How audio flows

The browser captures the microphone with the centralized engine: no echo
cancellation, noise suppression or gain control, the AudioContext's native rate,
an AudioWorklet that downmixes and resamples to 16 kHz with the streaming
windowed-sinc resampler, and 100 ms PCM16 chunks stamped at their trailing edge.
The microphone borrows the backing track's AudioContext, so capture time and
playback share one clock. Each chunk is mapped from capture time to song time
through the playback clock's observations of the playing media, and sent as the
centralized binary frame: magic, version, sequence, chunk ID, sample rate and
the chunk's song start and end in milliseconds, then the PCM.

The operator accepts those frames on `/attempt` for the learner's ticket and
runs one relay per take. The relay streams the audio to ElevenLabs over the
centralized adapter: a single-use token minted with Pirate's `xi-api-key`, then
`wss://api.elevenlabs.io/v1/speech-to-text/realtime` with `scribe_v2_realtime`,
`pcm_16000`, timestamps, manual commits and logging enabled, which means the
provider stores audio. It asks for a commit when a lyric line's end has been
sent and not yet covered, and on pause and finish. The adapter maps each
provider word's stream timestamps back to song time through the frames it sent,
and drops a word whose ends straddle a backward seek. Committed words are kept
by the relay and handed to the existing `words` path and scorer before the
take finishes, and whenever the learner's socket closes, so words already
heard reach the scorer even if the learner never returns.

Learners can no longer send `words` or `provider_failed` frames on the audio
socket; only the operator's provider path produces them.

## Seek, pause, reconnect and failure behavior

These follow the centralized client, session host and reducer.

- A pause or seek ends the capture epoch: the worklet flushes its tail, the
  anchor clears, and resuming re-anchors at the current song position.
- Initial activation waits for both a live socket and playing media.
- Context suspension pauses capture and offers tap-to-continue recovery; a
  closed context aborts the take.
- A chunk the playback clock cannot map aborts the take rather than guessing.
- The browser reconnects a dropped socket after 250 ms, doubling to at most
  2 s, five times. It suspends capture once per gap, resumes on a fresh anchor
  only after that suspend completes, keeps one frame sequence across
  reconnects and never replays audio. A socket superseded by the learner's
  newer connection (close 4409) does not reconnect.
- The operator refuses audio whose sequence does not increase.
- On a backward seek the relay drops words ending after the seek point minus
  300 ms, drops any commit reaching past it and its late words, and reopens
  lines after it.
- A dropped provider stream reconnects after 250 ms, doubling to at most 2 s,
  five times. Up to 600 frames are buffered during the outage and replayed.
  The dead stream's unacknowledged commit is orphaned.
- A commit unacknowledged after 2 s, an orphaned commit, a terminal provider
  error, exhausted reconnects and a missing credential make the affected lines
  `provider_failed`, which the existing result reports as `unmeasured`, never
  as wrong.

Two deliberate changes from the centralized code:

1. A pause flushes the capture tail before telling the operator. The centralized
   client sent pause first, and its server rejected the flushed audio as
   arriving while paused.
2. A first chunk stamped up to 25 ms before its epoch's anchor maps from the
   anchor. The worklet stamps from the first render quantum it processes,
   which can precede the main thread's anchor reading by about one quantum. In
   the centralized code that case aborted the take with
   `karaoke_clock_unavailable`; the browser acceptance reproduced it
   intermittently before the change and passed five consecutive full runs after
   it. A chunk starting earlier than that still aborts.

Known limits: words handed to the scorer at a disconnect are final, so a later
seek cannot remove them. After a backward seek the adapter's commit frontier
stays at the highest song time sent, as in the centralized adapter. Relay state
other than its persisted words and failure marks lives in memory, so an operator
restart mid-take loses the provider stream. Live per-line scores and partial
transcripts are not sent to the learner; the operator's signed result remains
the outcome.

## Source and transformations

Each copy starts with a provenance comment. "Constructor fields" means
TypeScript parameter properties written out as constructor-assigned fields,
because Node's strip-only TypeScript cannot run them.

| Upstream file | SHA-256 | Copy | Change |
|---|---|---|---|
| pirate-web-solid 667a6f22 karaoke/capture/karaoke-capture-dsp.ts | `de2d57fee8aa3c52455efe728f5ac5ea5cda97fb3a99c0464b309bc86adc11ea` | packages/karaoke/capture-dsp.ts | none |
| karaoke/capture/karaoke-capture-lifecycle.ts | `f4216423771737942612cce915e009cc8561bea7aab1757d89622706cf3b156b` | packages/karaoke/capture-lifecycle.ts | none |
| karaoke/capture/karaoke-mic-capture.ts | `75aeba56aa2e8c9765cd1e36901d2368404b73c17e1ca2b2f42378669251ef93` | packages/karaoke/mic-capture.ts | import path |
| karaoke/capture/karaoke-capture-processor.ts | `286ec640c9ae05bb6ba88e9fa324397e091145c329413a756acb4ebcbaf623be` | apps/web/src/karaoke/capture-processor.ts | import path |
| karaoke/capture/karaoke-mic-capture-browser.ts | `e28eecb7ff50653ff9a120a7e58d57283e1db1409322fd63fceb977df009de57` | apps/web/src/karaoke/mic-capture-browser.ts | import path |
| api-next a5c63b8 karaoke-runtime/transport.ts | `7ef5d4cffaab1563b53f50c3a5579fb804495c02c2f64891f930e939063f8fd8` | packages/karaoke/transport.ts | import path |
| karaoke-runtime/binary-codec.ts | `efb69902265791fdee8562c473f9d35084fbf3fec33398ce6f8b98876a057c98` | packages/karaoke/binary-codec.ts | import paths |
| karaoke-runtime/session-host.ts lines 21-77 | `153d3268783139a3f561243184dffdf0fa66c61afdb0279513a3bbf83238e667` | packages/karaoke/stt-adapter.ts | adapter contract only |
| platform-cf/src/elevenlabs-karaoke-stt.ts | `017d62c1c0ccb8289659656a5111dee8383936af3d4e1737a09d2e827eaa6a5c` | packages/karaoke/elevenlabs-realtime.ts | imports, constructor fields |

These are adaptations rather than copies, written against the operator socket:

| Source | SHA-256 | New file |
|---|---|---|
| pirate-web-solid 667a6f22 karaoke/runtime/karaoke-session-client.ts | `d3665c404cfc45d21e79881bbedbd7fd6c75225583fda0271e2e07b8a8dd2211` | packages/karaoke/operator-audio-client.ts |
| karaoke/scoring/karaoke-scoring-controller.ts | `fb1624f2850376f0de0a84255a44728b4425df696daf602a58b0c3f96381c332` | packages/karaoke/capture-controller.ts |
| karaoke/scoring/use-karaoke-scoring-session.ts | `f95a5c09720c2373f15fe3134ac4ec6aad64e00d9cb2954e28a239c7d435df0b` | apps/web/src/karaoke/use-karaoke-capture.ts |
| api-next a5c63b8 karaoke-runtime/session-host.ts and session.ts | `153d3268…`, `32df2bef7340b0d724baab563213b303aee5da91d1767e11687bd543c07a443f` | packages/karaoke/audio-relay.ts |

`services/karaoke-audio.ts` is the operator's audio socket and
`services/karaoke-audio-runtime.ts` its entry. Adopted tests run unchanged apart
from imports through `test/karaoke-expect.ts`, which gained `toHaveLength`,
`toBeUndefined`, error-class `toThrow` and `Bun.sleep`.

| Upstream test | SHA-256 | Copy |
|---|---|---|
| karaoke/capture/karaoke-capture-dsp.test.ts | `0544f072d2232ed5c8f3029576f0f6809a87a59d9f1ecef9eb97bb51b48f7ed2` | test/karaoke-capture-dsp.test.ts |
| karaoke/capture/karaoke-capture-lifecycle.test.ts | `3bbb67adc780d31502f9b92e70f8f50be496728a941d57579a9f312986a8828a` | test/karaoke-capture-lifecycle.test.ts |
| karaoke/capture/karaoke-mic-capture.test.ts | `4f7f31be04f79be8cbfd3227fc8ae24131a2ca0adfc5b052dd897f429dde34f8` | test/karaoke-mic-capture.test.ts |
| karaoke-runtime/tests/binary-codec.test.ts | `2253aff571fa1b22912a6b842bdc291f0771b06ffb12edef476b526f2a6a68c5` | test/karaoke-binary-codec.test.ts |
| platform-cf/src/elevenlabs-karaoke-stt.test.ts | `58da035fe90f2a795b31a2ed259e3bd2b2a60f28ff240c73aa7c07a0605e9639` | test/karaoke-elevenlabs-realtime.test.ts |

All 47 upstream cases in those files pass.

## Tests

`test/karaoke-audio-operator.test.ts` boots the actual operator worker with the
audio subclass on local anvil, and routes the operator's outbound network, the
real ElevenLabs address included, to `harness/karaoke-elevenlabs-simulator.ts`.
The simulator checks the key, mints single-use tokens, accepts the realtime
messages and returns scripted words on each stream's own clock. Eight cases
cover the scored path at exact song times and request parameters, refused
learner words, a dropped provider stream with replay and an orphaned commit, a
terminal error, a missing credential, a backward seek, a learner reconnect on
the same provider stream with refused regressed audio, and commits that are
never acknowledged.

`test/karaoke-operator-audio-client.test.ts` and
`test/karaoke-capture-controller.test.ts` cover the browser-side rules with
fakes. In `apps/web/karaoke-e2e/capture.spec.ts`, Chromium's fake microphone
feeds the real worklet, client and operator socket through
`apps/web/karaoke-e2e/capture-host.ts`, which runs the same operator and
simulator beside anvil. One scenario checks that the provider's words are stored
at one consistent song offset from capture start. The other drops the socket
mid-take and checks that the take continues on the same provider stream, with
later words shifted by the dropped gap, which shows that audio was not
replayed. `.github/workflows/karaoke.yml` runs all of this with external
networking unavailable.

## Wiring for the coordinator

1. Adopt the new files. Either deploy the operator from
   `services/karaoke-audio-runtime.ts`, or fold `KaraokeAudioState` into
   `ServiceState` in `services/runtime.ts`: route binary frames and the
   `audio_pause`, `audio_seek` and `finish` text frames through it, refuse
   learner `words` and `provider_failed`, and call its close handler before the
   existing `onClose`.
2. Bind `ELEVENLABS_API_KEY` to the operator only, from Pirate's managed
   secret. Without it the operator calls no provider and marks lines
   unmeasured. The operator's outbound network must reach `api.elevenlabs.io`.
3. Add the shared daily speech-call count from the Study handoff to the relay's
   provider starts and reconnects before public use.
4. Mount `useKaraokeCapture` with the ticket's socket URL and connection proof,
   and pass its controls to `KaraokePracticeSurface` as
   `apps/web/src/karaoke/entry.tsx` does. Segment purchases go over the same
   socket through the client's `send`; they belong to the integration slice.
5. The Privacy Policy must say that Karaoke audio is sent to ElevenLabs, which
   stores it, and that the operator keeps recognized words and scores.
