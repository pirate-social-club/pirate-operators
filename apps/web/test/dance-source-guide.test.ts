/** UNRUN. Original c7 guide scheduling/lifetime assertions on actual controller.
 * Web Audio is a named simulation; this is not device/output-latency evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { prepareDanceCaptureGuide } from "../src/dance/source/dance-capture-guide.ts";
import { simulatedSource } from "./dance-source-fixtures.ts";
function audioSimulation() {
  const events = new EventTarget(),
    starts: number[][] = [];
  let state: AudioContextState = "running",
    closes = 0,
    resumes = 0,
    released = 0;
  const node = {
    buffer: null,
    playbackRate: { value: 1 },
    connect: () => {},
    disconnect: () => {},
    stop: () => {},
    start: (...args: number[]) => {
      starts.push(args);
    },
    onended: null,
  };
  const audio = {
    get state() {
      return state;
    },
    currentTime: 10,
    sampleRate: 48000,
    destination: {},
    resume: async () => {
      resumes++;
      state = "running";
    },
    close: async () => {
      closes++;
      state = "closed";
    },
    decodeAudioData: async () => ({ duration: 100 }),
    createBufferSource: () => node,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  return {
    audio: audio as unknown as AudioContext,
    starts,
    resumes: () => resumes,
    closes: () => closes,
    released: () => released,
    source: {
      url: "blob:https://fixture.invalid/guide",
      blob: new Blob(["guide"]),
      release: () => {
        released++;
      },
    },
    state: (s: AudioContextState) => {
      state = s;
      events.dispatchEvent(new Event("statechange"));
    },
  };
}
for (const elapsed of [0, 25, 250])
  test(`no-pose keeps actual ${elapsed}ms source offset without time stretch`, async () => {
    const f = simulatedSource(),
      a = audioSimulation();
    const guide = await prepareDanceCaptureGuide(
      {
        context: f.ready.context,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      },
      {
        prepareSource: async () => a.source,
        createAudioContext: () => a.audio,
        nowMs: () => 1000,
      },
    );
    try {
      guide.start(
        1000 - elapsed,
        () => {},
        () => {},
      );
      assert.deepEqual(a.starts[0], [
        10,
        f.c.startSample / 48000 + elapsed / 1000,
        f.c.durationSamples / 48000 - elapsed / 1000,
      ]);
      assert.equal(a.released(), 1);
    } finally {
      guide.dispose();
    }
  });
for (const elapsed of [251, -1])
  test(`missed/future guide origin ${elapsed}ms refuses instead of moving the interval`, async () => {
    const f = simulatedSource(),
      a = audioSimulation();
    const guide = await prepareDanceCaptureGuide(
      {
        context: f.ready.context,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      },
      {
        prepareSource: async () => a.source,
        createAudioContext: () => a.audio,
        nowMs: () => 1000,
      },
    );
    try {
      assert.throws(
        () =>
          guide.start(
            1000 - elapsed,
            () => {},
            () => {},
          ),
        /start_missed/,
      );
      assert.equal(a.starts.length, 0);
    } finally {
      guide.dispose();
    }
  });
test("prepared suspended guide unlocks on Record, fetches once, and ends on suspension", async () => {
  const f = simulatedSource(),
    a = audioSimulation();
  a.state("suspended");
  let failures = 0;
  const guide = await prepareDanceCaptureGuide(
    {
      context: f.ready.context,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      deferActivation: true,
    },
    {
      prepareSource: async () => a.source,
      createAudioContext: () => a.audio,
      nowMs: () => 1000,
    },
  );
  assert.equal(a.resumes(), 0);
  const activation = guide.activate();
  assert.equal(a.resumes(), 1);
  await activation;
  guide.start(
    1000,
    () => {},
    () => {
      failures++;
    },
  );
  a.state("suspended");
  a.state("closed");
  assert.equal(failures, 1);
  assert.equal(a.released(), 1);
  assert.equal(a.closes(), 1);
  guide.dispose();
});
test("aborting decode cannot return a guide or leak the verified blob", async () => {
  const f = simulatedSource(),
    a = audioSimulation(),
    abort = new AbortController();
  let decode!: (b: AudioBuffer) => void, entered!: () => void;
  const began = new Promise<void>((r) => {
    entered = r;
  });
  a.audio.decodeAudioData = async () => {
    entered();
    return new Promise((r) => {
      decode = r;
    });
  };
  const pending = prepareDanceCaptureGuide(
    { context: f.ready.context, signal: abort.signal, assertCurrent: () => {} },
    { prepareSource: async () => a.source, createAudioContext: () => a.audio },
  );
  await began;
  abort.abort();
  decode({ duration: 100 } as AudioBuffer);
  await assert.rejects(pending);
  assert.equal(a.released(), 1);
  assert.equal(a.closes(), 1);
});
