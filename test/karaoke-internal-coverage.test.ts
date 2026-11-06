import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { startChain, stopChain, type Chain } from "./payments-fixture.ts";
import {
  audioCommunity,
  AUDIO_MANIFEST,
  sungAudioWords,
  storedAudioWords,
} from "./karaoke-audio-fixture.ts";
import {
  PAYMENT_GRACE_S,
  RECONNECT_WINDOW_S,
  songEndMs,
} from "../packages/protocol/payments.ts";
import type { KaraokeRelaySnapshot } from "../packages/karaoke/audio-relay.ts";
import type { SimulatedStream } from "../harness/karaoke-elevenlabs-simulator.ts";
import {
  INTERNAL_COMPLETION_GRACE_S,
  type Attempt as StoredAttempt,
} from "../services/karaoke-result.ts";
let evm: Chain;
before(async () => {
  evm = await startChain(19079);
});
after(async () => {
  await stopChain(evm);
});
const internal = (label: string, streams: SimulatedStream[]) =>
  audioCommunity(evm, label, streams, undefined, { serviceMode: "internal" });
type C = Awaited<ReturnType<typeof internal>>;
type A = Awaited<ReturnType<C["attempt"]>>;
async function resolved(c: C, a: A, ms: number) {
  for (let i = 0; i < 100; i++) {
    const r = (await c.state(`audioRelay:${a.ticket.body.ticketId}`))[0]
      ?.value as KaraokeRelaySnapshot | undefined;
    if ((r?.resolvedThroughMs ?? 0) >= ms) return r!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("provider_coverage_not_resolved");
}
async function terminal(c: C, a: A, at?: number) {
  await c.at(
    at ??
      a.start.body.startedAt +
        Math.ceil(songEndMs(a.manifest) / 1000) +
        INTERNAL_COMPLETION_GRACE_S +
        PAYMENT_GRACE_S +
        1,
  );
  const row = (await c.state(`attempt:${a.ticket.body.ticketId}`))[0].value as {
    finalized: boolean;
  };
  assert.equal(
    row.finalized,
    true,
    "the actual alarm must finalize before a result request",
  );
  const result = await c.result(a.ticket.body.ticketId);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.body.serviceMode, "internal");
  assert.deepEqual(result.value.body.billing, []);
  return result.value.body;
}

test("internal alarm finalization without any frames is unmeasured and calls no provider", async () => {
  const c = await internal("no-audio", []);
  try {
    const a = await c.attempt();
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("unmeasured"),
    );
    assert.ok(r.lines.every((l) => l.scoreBps === null));
    assert.equal(r.rewardScoreBps, null);
    assert.equal((await c.simulator()).minted, 0);
  } finally {
    await c.dispose();
  }
});

test("an acknowledged partial prefix keeps its words but cannot grade the missing remainder", async () => {
  const c = await internal("partial-prefix", [
    { words: [{ text: "sing", start: 0.2, end: 0.8 }] },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 900);
    await c.waitForProviderChunks(9);
    a.socket.send({ type: "audio_pause" });
    await resolved(c, a, 900);
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("unmeasured"),
    );
    assert.ok(r.lines.every((l) => l.scoreBps === null));
    assert.equal((await storedAudioWords(c, a)).length, 1);
  } finally {
    await c.dispose();
  }
});

test("a fully acknowledged line keeps its grade while the missing tail is unmeasured", async () => {
  const c = await internal("covered-prefix", [
    { words: sungAudioWords(AUDIO_MANIFEST, ["line-01"]) },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 2000);
    await resolved(c, a, 2000);
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["assessed", "unmeasured", "unmeasured", "unmeasured"],
    );
    assert.equal((await storedAudioWords(c, a)).length, 2);
  } finally {
    await c.dispose();
  }
});

test("fully acknowledged no-word audio remains measured silence", async () => {
  const c = await internal("measured-silence", [{ words: [] }]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 22000);
    await resolved(c, a, 22000);
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("silent"),
    );
    assert.equal(r.unmeasuredCount, 0);
    assert.equal(r.rewardScoreBps, 0);
  } finally {
    await c.dispose();
  }
});

test("resolved coverage and words survive an actual Worker restart", async () => {
  const c = await internal("restored-prefix", [
    { words: sungAudioWords(AUDIO_MANIFEST, ["line-01"]) },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 2000);
    await resolved(c, a, 2000);
    await c.restart();
    const socket = await c.reconnect(a);
    assert.equal(socket.ready.resumed, true);
    assert.equal(socket.ready.audioSequence, 20);
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["assessed", "unmeasured", "unmeasured", "unmeasured"],
    );
    assert.equal((await storedAudioWords(c, a)).length, 2);
  } finally {
    await c.dispose();
  }
});

test("abandonment preserves a covered line and separates missing measurement from unreached lines", async () => {
  const c = await internal("abandoned-prefix", [
    { words: sungAudioWords(AUDIO_MANIFEST, ["line-01"]) },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 2000);
    await resolved(c, a, 2000);
    await c.at(a.start.body.startedAt + 3);
    a.socket.ws.close();
    for (let i = 0; i < 100; i++) {
      const row = (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
        .value as { disconnectedAt: number | null };
      if (row.disconnectedAt !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await terminal(
      c,
      a,
      a.start.body.startedAt + 3 + RECONNECT_WINDOW_S + PAYMENT_GRACE_S + 1,
    );
    assert.equal(r.status, "abandoned");
    assert.equal(r.performanceEndedAt, a.start.body.startedAt + 3);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["assessed", "unmeasured", "unattempted", "unattempted"],
    );
  } finally {
    await c.dispose();
  }
});

test("late final audio fits the bounded ingress grace without moving the performance or payment cutoff", async () => {
  const c = await internal("late-final-frame", [
    {
      words: sungAudioWords(
        AUDIO_MANIFEST,
        AUDIO_MANIFEST.lines.map((l) => l.lineId),
      ),
    },
  ]);
  try {
    const a = await c.attempt();
    const durationMs = songEndMs(a.manifest);
    const nominal = a.start.body.startedAt + Math.ceil(durationMs / 1000);
    await c.sing(a.socket, a, 0, durationMs - 100);
    await resolved(c, a, a.manifest.lines.at(-2)!.endMs);
    // Model floor-second start at +999 ms, a 100 ms capture/flush and 500 ms
    // delivery independently. The real handler then receives at this second.
    const arrivalMs =
      a.start.body.startedAt * 1000 + 999 + durationMs + 100 + 500;
    const arrivalSecond = Math.floor(arrivalMs / 1000);
    assert.equal(arrivalSecond, nominal + 1);
    await c.at(arrivalSecond);
    const pending = (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
      .value as StoredAttempt;
    assert.equal(pending.ended, null);
    await c.sing(a.socket, a, durationMs - 100, durationMs + 100);
    await resolved(c, a, durationMs);
    a.socket.send({ type: "finish" });
    for (let i = 0; i < 100; i++) {
      const ended = (
        (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
          .value as StoredAttempt
      ).ended;
      if (ended) {
        assert.equal(ended.endedAt, arrivalSecond);
        assert.equal(ended.performanceEndedAt, nominal);
        assert.equal(ended.paymentDeadline, nominal + PAYMENT_GRACE_S);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
      if (i === 99) assert.fail("explicit_finish_not_processed");
    }
    const r = await terminal(c, a, nominal + PAYMENT_GRACE_S);
    assert.equal(r.performanceEndedAt, nominal);
    assert.equal(r.status, "completed");
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("assessed"),
    );
  } finally {
    await c.dispose();
  }
});

test("the completion decision grace is finite and does not invent missing measurement", async () => {
  const c = await internal("bounded-final-frame", []);
  try {
    const a = await c.attempt();
    const nominal =
      a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000);
    await c.at(nominal + INTERNAL_COMPLETION_GRACE_S);
    const ended = (
      (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
        .value as StoredAttempt
    ).ended!;
    assert.equal(ended.status, "completed");
    assert.equal(ended.performanceEndedAt, nominal);
    assert.equal(ended.endedAt, nominal + INTERNAL_COMPLETION_GRACE_S);
    assert.equal(ended.paymentDeadline, nominal + PAYMENT_GRACE_S);
    const r = await terminal(c, a, nominal + PAYMENT_GRACE_S);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("unmeasured"),
    );
    assert.ok(r.lines.every((l) => l.scoreBps === null));
    assert.equal((await c.simulator()).minted, 0);
  } finally {
    await c.dispose();
  }
});

test("genuine early finish keeps its earlier performance and payment cutoff", async () => {
  const c = await internal("early-finish", []);
  try {
    const a = await c.attempt();
    const finish = a.start.body.startedAt + 3;
    await c.at(finish);
    a.socket.send({ type: "finish" });
    // Process finish before advancing the clock; the normal state route only reads.
    for (let i = 0; i < 100; i++) {
      if (
        (
          (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
            .value as StoredAttempt
        ).ended
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
      if (i === 99) assert.fail("explicit_finish_not_processed");
    }
    const r = await terminal(c, a, finish + PAYMENT_GRACE_S);
    assert.equal(r.performanceEndedAt, finish);
    assert.equal(r.endedAt, finish);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["unmeasured", "unmeasured", "unattempted", "unattempted"],
    );
  } finally {
    await c.dispose();
  }
});

test("a valid late-open ticket still expires before completion and rejects later audio", async () => {
  const c = await internal("hard-ticket-expiry", []);
  try {
    const a = await c.attempt(5, async (signed) =>
      c.at(signed.body.expiresAt - 1),
    );
    assert.equal(a.start.body.startedAt, a.ticket.body.expiresAt - 1);
    const expiry = a.ticket.body.expiresAt;
    await c.at(expiry);
    const ended = (
      (await c.state(`attempt:${a.ticket.body.ticketId}`))[0]
        .value as StoredAttempt
    ).ended!;
    assert.equal(ended.status, "expired");
    assert.equal(ended.endedAt, expiry);
    assert.equal(ended.performanceEndedAt, expiry);
    await c.sing(a.socket, a, 0, 100);
    const r = await terminal(c, a, expiry + PAYMENT_GRACE_S);
    assert.equal(r.performanceEndedAt, expiry);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["unmeasured", "unattempted", "unattempted", "unattempted"],
    );
    assert.equal((await c.simulator()).minted, 0);
  } finally {
    await c.dispose();
  }
});

test("received audio without provider acknowledgement is never measured silence", async () => {
  const c = await internal("unacknowledged-audio", [
    { words: [], ignoreCommits: true },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 22000);
    await c.waitForProviderChunks(220);
    const state = await resolved(c, a, 2000);
    assert.ok(
      state.failedLineIds.includes("line-01"),
      "a timeout frontier carries its failure evidence",
    );
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      Array(4).fill("unmeasured"),
    );
  } finally {
    await c.dispose();
  }
});

test("a fresh provider stream cannot measure the unacknowledged tail lost in a restart", async () => {
  const c = await internal("lost-restart-tail", [
    {
      words: sungAudioWords(AUDIO_MANIFEST, ["line-01"]),
      answerCommits: 1,
    },
  ]);
  try {
    const a = await c.attempt();
    await c.sing(a.socket, a, 0, 2000);
    await resolved(c, a, 2000);
    await c.sing(a.socket, a, 2000, 4500);
    await c.waitForProviderChunks(45);
    const prior = (await c.state(`audioRelay:${a.ticket.body.ticketId}`))[0]
      .value as KaraokeRelaySnapshot;
    assert.equal(prior.resolvedThroughMs, 2000);
    assert.equal(prior.lastAudioEndMs, 4500);
    assert.deepEqual(
      prior.failedLineIds,
      [],
      "restart happens before the old acknowledgement timeout",
    );
    await c.restart();
    const socket = await c.reconnect(a);
    assert.equal(socket.ready.audioSequence, 45);
    await c.sing(socket, a, 4500, 5000);
    const restored = await resolved(c, a, 4900);
    assert.ok(restored.failedLineIds.includes("line-02"));
    const r = await terminal(c, a);
    assert.deepEqual(
      r.lines.map((l) => l.status),
      ["assessed", "unmeasured", "unmeasured", "unmeasured"],
    );
  } finally {
    await c.dispose();
  }
});
