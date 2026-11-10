import test from "node:test";
import assert from "node:assert/strict";
import {
  KaraokeAudioRelay,
  type KaraokeRelaySnapshot,
} from "../packages/karaoke/audio-relay.ts";
import {
  makeElevenLabsKaraokeSocketConnect,
  type KaraokeSttSocket,
} from "../packages/karaoke/elevenlabs-realtime.ts";
import {
  admittedKaraokeAdapter,
  type KaraokeSpeechDispatch,
} from "../services/karaoke-speech-adapter.ts";
import { digest } from "../packages/protocol/index.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";

class SimulatedSocket implements KaraokeSttSocket {
  private listeners = new Map<string, ((event: { data: string }) => void)[]>();
  sent: string[] = [];
  accept() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  addEventListener(
    type: string,
    listener: ((event: { data: string }) => void) | (() => void),
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  drop() {
    for (const listener of this.listeners.get("close") ?? [])
      listener({ data: "" });
  }
  emit(value: unknown) {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: JSON.stringify(value) });
  }
}
const audio = (sequence: number) => ({
  protocolVersion: 1 as const,
  sessionId: "ticket-repair1",
  attemptId: "attempt-repair1",
  sequence,
  type: "audio_chunk" as const,
  chunkId: sequence,
  pcm16: new ArrayBuffer(32000),
  sampleRate: 16000 as const,
  songStartMs: (sequence - 1) * 1000,
  songEndMs: sequence * 1000,
});
const ready = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(
    predicate(),
    true,
    "controlled provider progress did not complete",
  );
};
const startInput = {
  sessionId: "ticket-repair1",
  attemptId: "attempt-repair1",
  initialSequence: 0,
  onMessage: async () => {},
};

test("configured admission follows the actual relay provider reconnect path with new durable identities, including restore", async () => {
  const f = speechRepairFixture();
  const sockets: SimulatedSocket[] = [];
  let tokenCalls = 0;
  const connect = makeElevenLabsKaraokeSocketConnect(async (_request, init) => {
    if (init?.method === "POST") {
      tokenCalls++;
      return Response.json({ token: "fixture-token" });
    }
    const socket = new SimulatedSocket();
    sockets.push(socket);
    return Object.assign(new Response(null), { webSocket: socket });
  });
  let saved: KaraokeRelaySnapshot | undefined;
  let reconnectWait: Promise<void> = Promise.resolve();
  let release!: () => void;
  const create = () =>
    admittedKaraokeAdapter({
      env: f.env,
      store: f.store,
      ticketId: "ticket-repair1",
      learnerGeneration: 7,
      apiKey: "fixture-key",
      admissionRequired: true,
      connect,
    });
  const make = (restore?: KaraokeRelaySnapshot) =>
    new KaraokeAudioRelay({
      sessionId: "ticket-repair1",
      attemptId: "attempt-repair1",
      lines: [],
      createAdapter: create,
      restore,
      persist: (snapshot) => {
        saved = structuredClone(snapshot);
      },
      delay: () => reconnectWait,
    });
  let relay = make();
  try {
    await relay.audio(audio(1));
    reconnectWait = new Promise((resolve) => {
      release = resolve;
    });
    sockets[0].drop();
    await relay.audio(audio(2)); // buffered during the controlled reconnect
    release();
    await ready(() => sockets.length === 2 && sockets[1].sent.length === 1);
    assert.equal(relay.terminal, null);
    await relay.pause();
    sockets[1].emit({
      message_type: "committed_transcript_with_timestamps",
      text: "home",
      words: [{ text: "home", start: 0, end: 0.5 }],
    });
    await ready(() => (saved?.words.length ?? 0) === 1);
    assert.equal(relay.drain().words[0].text, "home");
    const restore = structuredClone(saved!);
    await relay.close();
    relay = make(restore);
    await relay.audio(audio(3));
    assert.equal(tokenCalls, 3);
    assert.equal(
      f.store.get<number>("karaokeSpeechSequence:ticket-repair1"),
      3,
    );
    for (const ordinal of [1, 2, 3]) {
      const id = `karaoke:ticket-repair1:stream:${ordinal}`;
      assert.equal(f.admission.get(id)?.state, "succeeded");
      assert.equal(
        f.store.get<KaraokeSpeechDispatch>(`karaokeSpeechDispatch:${id}`)
          ?.learnerGeneration,
        7,
      );
      assert.equal(f.admission.dispatch(id).dispatch, false);
    }
    // Completed provider starts still consume non-website capacity.
    assert.throws(
      () =>
        f.admission.reserve({
          communityId: f.policy.communityId,
          keyGeneration: f.policy.keyGeneration,
          channel: "telegram-linked",
          requestId: "oversubscribed",
          payloadDigest: digest("fixture"),
          units: 4,
        }),
      /capacity_reserved/,
    );
    assert.equal(
      f.admission.reserve({
        communityId: f.policy.communityId,
        keyGeneration: f.policy.keyGeneration,
        channel: "website-study",
        requestId: "reserved-web",
        payloadDigest: digest("fixture"),
        units: 4,
      }).state,
      "reserved",
    );
  } finally {
    await relay.close();
    f.close();
  }
});

test("explicit token HTTP429 releases capacity with structured durable evidence and never opens a stream", async () => {
  const f = speechRepairFixture({
    dailyUnits: 2,
    websiteStudyReservedUnits: 1,
    telegramTrialUnits: 1,
  });
  let calls = 0;
  const connect = makeElevenLabsKaraokeSocketConnect(async () => {
    calls++;
    return new Response("fixture refusal body must not be retained", {
      status: 429,
    });
  });
  try {
    const adapter = admittedKaraokeAdapter({
      env: f.env,
      store: f.store,
      ticketId: "refusal",
      learnerGeneration: 1,
      apiKey: "fixture-key",
      admissionRequired: true,
      connect,
    });
    await assert.rejects(adapter.start(startInput), /token_mint_failed_429/);
    assert.equal(calls, 1);
    const id = "karaoke:refusal:stream:1";
    assert.equal(f.admission.get(id)?.state, "refused");
    const record = f.store.get<KaraokeSpeechDispatch>(
      `karaokeSpeechDispatch:${id}`,
    )!;
    assert.deepEqual(record.evidence, {
      schema: "pirate.karaoke-token-refusal/1",
      phase: "token-mint",
      httpStatus: 429,
      providerStreamOpened: false,
      requestId: id,
    });
    assert.equal(f.admission.get(id)?.evidenceDigest, digest(record.evidence));
    assert.equal(
      JSON.stringify(record).includes("fixture refusal body"),
      false,
    );
    assert.equal(
      f.admission.reserve({
        communityId: f.policy.communityId,
        keyGeneration: f.policy.keyGeneration,
        channel: "telegram-trial",
        requestId: "trial-after-refusal",
        payloadDigest: digest("fixture"),
        units: 1,
      }).state,
      "reserved",
    );
  } finally {
    f.close();
  }
});

test("upgrade uncertainty and post-stream provider loss remain charged", async () => {
  for (const opened of [false, true]) {
    const f = speechRepairFixture({
      dailyUnits: 2,
      websiteStudyReservedUnits: 1,
      telegramTrialUnits: 1,
    });
    const socket = new SimulatedSocket();
    const connect = makeElevenLabsKaraokeSocketConnect(
      async (_request, init) => {
        if (init?.method === "POST")
          return Response.json({ token: "fixture-token" });
        if (!opened) throw Error("fixture upgrade response lost");
        return Object.assign(new Response(null), { webSocket: socket });
      },
    );
    const adapter = admittedKaraokeAdapter({
      env: f.env,
      store: f.store,
      ticketId: "uncertain",
      learnerGeneration: 1,
      apiKey: "fixture-key",
      admissionRequired: true,
      connect,
    });
    try {
      if (opened) {
        await adapter.start(startInput);
        socket.drop();
      } else await assert.rejects(adapter.start(startInput), /response lost/);
      assert.equal(
        f.admission.get("karaoke:uncertain:stream:1")?.state,
        opened ? "succeeded" : "unknown",
      );
      assert.throws(
        () =>
          f.admission.reserve({
            communityId: f.policy.communityId,
            keyGeneration: f.policy.keyGeneration,
            channel: "telegram-trial",
            requestId: "no-refund",
            payloadDigest: digest("fixture"),
            units: 1,
          }),
        /capacity_reserved/,
      );
    } finally {
      await adapter.close();
      f.close();
    }
  }
});

test("ambiguous token-mint server failures remain charged without guessing a refusal from error text", async () => {
  const f = speechRepairFixture();
  const connect = makeElevenLabsKaraokeSocketConnect(
    async () => new Response(null, { status: 503 }),
  );
  const adapter = admittedKaraokeAdapter({
    env: f.env,
    store: f.store,
    ticketId: "token-unknown",
    learnerGeneration: 1,
    apiKey: "fixture-key",
    admissionRequired: true,
    connect,
  });
  try {
    await assert.rejects(adapter.start(startInput), /token_mint_failed_503/);
    assert.equal(
      f.admission.get("karaoke:token-unknown:stream:1")?.state,
      "unknown",
    );
  } finally {
    await adapter.close();
    f.close();
  }
});
