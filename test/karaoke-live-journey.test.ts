// One learner's complete Karaoke journey on the published first song, through
// the community application: sign-in, the instrumental, a ticket, the
// operator's audio socket, per-line purchases redeemed on chain, singing
// transcribed by simulated ElevenLabs, grades on the published line IDs,
// reload recovery, consent and the LearningRecords read back independently.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  serializeErc8010Signature,
  type Address,
  type Hex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { accounts } from "../harness/runtime.ts";
import { openAttempt, type Attempt } from "../harness/karaoke-client.ts";
import {
  firstSongFixture,
  karaokeLive,
  syntheticMp3,
  type KaraokeLive,
} from "../harness/karaoke-live.ts";
import {
  DEFAULT_ALIGNMENT,
  simulatedAlignment,
  type SimulatedStream,
} from "../harness/karaoke-elevenlabs-simulator.ts";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import { publishedKaraokeManifest } from "../packages/karaoke/published-manifest.ts";
import { KARAOKE_MAX_SEGMENT_MS } from "../services/karaoke-song.ts";
import { encodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import {
  digest,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import {
  PAYMENT_GRACE_S,
  songEndMs,
  type KaraokeManifest,
  type KaraokeResultBody,
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import {
  consentMessage,
  consentTypes,
  songKeyOf,
  type Consent,
} from "../packages/protocol/records.ts";
import { readLearner } from "../packages/records/reader.ts";
import {
  chainTime,
  startChain,
  stopChain,
  type Chain,
} from "./payments-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(19246);
});
after(async () => {
  await stopChain(evm);
});

const MUMBLED = 3;
const UNPAID = 5;
/** The provider hears every line as written except one, sung as mumbling. */
function stream(manifest: KaraokeManifest): SimulatedStream {
  return {
    words: manifest.lines.flatMap((line) =>
      line.words.map((w) => ({
        text: line.ordinal === MUMBLED ? "mumble" : w.text,
        start: w.startMs / 1000,
        end: w.endMs / 1000,
      })),
    ),
  };
}

async function timedSong(live: KaraokeLive) {
  await live.publish();
  assert.equal((await live.align()).value.state, "complete");
  const timed = await live.get<KaraokeManifest>(
    null,
    `/api/public/posts/${firstSongFixture.postId}/karaoke`,
  );
  assert.equal(timed.status, 200, JSON.stringify(timed.value));
  return timed.value;
}
/** The timings the simulated provider gives the published lyrics, computed offline. */
async function expectedManifest() {
  const { durationMs } = await syntheticMp3(120000);
  return publishedKaraokeManifest(
    firstSongFixture.lyrics,
    alignmentResult(
      simulatedAlignment(firstSongFixture.lyrics.sourceText, DEFAULT_ALIGNMENT),
      firstSongFixture.lyrics,
      durationMs,
    ),
    KARAOKE_MAX_SEGMENT_MS,
  );
}
async function liveSong(streams: (m: KaraokeManifest) => SimulatedStream[]) {
  const expected = await expectedManifest();
  const live = await karaokeLive({
    evm,
    now: (await chainTime(evm)) + 1,
    streams: streams(expected),
  });
  assert.deepEqual(await timedSong(live), expected);
  return { live, manifest: expected };
}

type Session = Awaited<ReturnType<KaraokeLive["signIn"]>>;
async function ticketFor(live: KaraokeLive, session: Session) {
  const issued = await live.post<{
    ticket: Signed<Ticket>;
    socketUrl: string;
    proof: Hex;
    error?: string;
  }>(session, "/api/karaoke/tickets", { postId: firstSongFixture.postId });
  assert.equal(issued.status, 200, JSON.stringify(issued.value));
  return issued.value;
}
async function connect(live: KaraokeLive, ticketId: Hex, proof: Hex) {
  const socket = await openAttempt(live.mf, ticketId, { proof });
  assert(!("refused" in socket), JSON.stringify(socket));
  return socket as Attempt;
}
/** Buys one line inside its window, through the application, on the socket. */
async function buy(
  live: KaraokeLive,
  session: Session,
  socket: Attempt,
  ticketId: Hex,
  segmentId: string,
  start: Signed<{ startedAt: number }>,
) {
  const signed = await live.post<SignedPurchase & { error?: string }>(
    session,
    "/api/karaoke/purchases",
    { ticketId, segmentId, take: 0, attemptStart: start },
  );
  assert.equal(signed.status, 200, JSON.stringify(signed.value));
  const answer = await socket.pay(signed.value);
  assert.equal(answer.type, "paid", JSON.stringify(answer));
}
let sequence = 0;
async function sing(
  socket: Attempt,
  ticketId: Hex,
  attemptId: Hex,
  fromMs: number,
  toMs: number,
) {
  for (let ms = fromMs; ms < toMs; ms += 100) {
    sequence += 1;
    socket.ws.send(
      encodeKaraokeBinaryFrame({
        protocolVersion: 1,
        sessionId: ticketId,
        attemptId,
        sequence,
        type: "audio_chunk",
        chunkId: sequence,
        pcm16: new ArrayBuffer(3200),
        sampleRate: 16000,
        songStartMs: ms,
        songEndMs: ms + 100,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
type AttemptView = {
  state: "none" | "open" | "finished";
  ticket?: Signed<Ticket>;
  proof?: Hex;
  result?: Signed<KaraokeResultBody>;
  record?: {
    consented: boolean;
    publication: { state: string; reason?: string } | null;
  };
};
const current = (live: KaraokeLive, session: Session) =>
  live.get<AttemptView>(
    session,
    `/api/karaoke/attempt?postId=${firstSongFixture.postId}`,
  );
/** Advances the clocks until the result is signed after the payment grace. */
async function finalResult(live: KaraokeLive, session: Session) {
  for (let i = 0; i < 40; i++) {
    await live.at(live.now() + 1);
    const view = await current(live, session);
    if (view.value.state === "finished") return view.value;
  }
  throw new Error("result_not_final");
}
async function published(live: KaraokeLive, session: Session) {
  for (let i = 0; i < 80; i++) {
    await live.at(live.now() + 1);
    const view = (await current(live, session)).value;
    const state = view.record?.publication?.state;
    if (state === "published") return view;
    if (state === "failed")
      throw new Error(`publication_failed:${view.record?.publication?.reason}`);
  }
  throw new Error("publication_pending");
}
/** The independent reader, resolving the manifest from the public Karaoke route. */
const readRecords = (live: KaraokeLive, learner: Address) =>
  readLearner(
    {
      rpcUrl: evm.rpcUrl,
      records: evm.recordsContract,
      manifest: async (revision) => {
        const timed = await live.get<KaraokeManifest>(
          null,
          `/api/public/posts/${firstSongFixture.postId}/karaoke`,
        );
        return digest(timed.value) === revision ? timed.value : undefined;
      },
    },
    learner,
  );

test("a learner sings the published song, reloads, consents, and the grades reach LearningRecords", async () => {
  const { live, manifest } = await liveSong((m) => [stream(m), stream(m)]);
  try {
    const learner = accounts[5]!,
      postId = firstSongFixture.postId;
    assert.equal(
      (await live.get(null, `/api/karaoke/posts/${postId}/instrumental`))
        .status,
      401,
    );
    const session = await live.signIn(learner);
    const audio = await live.app(`/api/karaoke/posts/${postId}/instrumental`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.ok((await audio.arrayBuffer()).byteLength > 100000);
    assert.equal((await current(live, session)).value.state, "none");

    const { ticket, socketUrl, proof } = await ticketFor(live, session);
    const ticketId = ticket.body.ticketId;
    assert.equal(socketUrl, "wss://operator.localhost/attempt");
    assert.equal(ticket.body.songHash, songKeyOf(manifest.song!));
    assert.equal(ticket.body.participant, learner.address.toLowerCase());
    // The browser never holds the session key, only this ticket's proof.
    assert.notEqual(ticket.body.sessionKey, ticket.body.participant);
    let socket = await connect(live, ticketId, proof);
    const start = socket.ready.attemptStart!;
    const offered = socket.ready.consent as { message: Consent };
    assert.equal(offered.message.songKey, songKeyOf(manifest.song!));
    await buy(
      live,
      session,
      socket,
      ticketId,
      manifest.segments[0]!.segmentId,
      start,
    );

    // A reload mid-take, even in another tab: the page asks for its open
    // attempt, gets the same ticket and proof, and resumes on a new socket.
    socket.close();
    const reloaded = await current(live, session);
    assert.equal(reloaded.value.state, "open");
    assert.equal(reloaded.value.ticket!.body.ticketId, ticketId);
    assert.equal(
      (await ticketFor(live, session)).ticket.body.ticketId,
      ticketId,
    );
    socket = await connect(live, ticketId, reloaded.value.proof!);
    assert.equal(socket.ready.resumed, true);
    // Another learner's session sees none of it.
    const stranger = await live.signIn(accounts[7]!);
    assert.equal((await current(live, stranger)).value.state, "none");

    for (const segment of manifest.segments.slice(1)) {
      const line = manifest.lines.find((l) => l.lineId === segment.lineIds[0])!;
      if (line.ordinal === UNPAID) continue;
      const opens =
        start.body.startedAt +
        Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
      if (opens > live.now()) await live.at(opens);
      await buy(live, session, socket, ticketId, segment.segmentId, start);
    }
    await sing(
      socket,
      ticketId,
      start.body.attemptId,
      0,
      songEndMs(manifest) + 500,
    );
    // Finishing is the end of the performance, so it comes after the last line.
    await live.at(
      start.body.startedAt + Math.ceil(songEndMs(manifest) / 1000) - 1,
    );
    socket.send({ type: "finish" });
    await live.at(live.now() + PAYMENT_GRACE_S);
    socket.close();

    // A reload after the take shows the signed result and frees the ticket.
    const finished = await finalResult(live, session);
    const result = finished.result!.body;
    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.lines.map((l) => l.lineId),
      manifest.lines.map((l) => l.lineId),
    );
    const byOrdinal = (n: number) => result.lines[n - 1]!;
    assert.equal(byOrdinal(UNPAID).status, "unpaid");
    assert.equal(byOrdinal(UNPAID).scoreBps, null);
    assert.equal(byOrdinal(MUMBLED).status, "assessed");
    // Mumbling over the line's timing earns some credit, far below singing it.
    assert.ok(
      byOrdinal(MUMBLED).scoreBps! < 5000,
      JSON.stringify(byOrdinal(MUMBLED)),
    );
    for (const line of result.lines.filter(
      (_, i) => i + 1 !== UNPAID && i + 1 !== MUMBLED,
    )) {
      assert.equal(line.status, "assessed", JSON.stringify(line));
      assert.ok(line.scoreBps! >= 9000, JSON.stringify(line));
    }
    assert.deepEqual(finished.record, {
      attemptId: start.body.attemptId,
      consented: false,
      publication: null,
    });

    // Consent after the socket closed, through the application.
    const consentSignature = await learner.signTypedData({
      domain: (socket.ready.consent as { domain: never }).domain,
      types: consentTypes,
      primaryType: "Consent",
      message: consentMessage(offered.message),
    });
    const forged = await live.post<{ error: string }>(
      session,
      "/api/karaoke/consent",
      {
        ticketId,
        signature: await accounts[6]!.signTypedData({
          domain: (socket.ready.consent as { domain: never }).domain,
          types: consentTypes,
          primaryType: "Consent",
          message: consentMessage(offered.message),
        }),
      },
    );
    assert.notEqual(forged.status, 200);
    const consented = await live.post<{ consented: boolean }>(
      session,
      "/api/karaoke/consent",
      {
        ticketId,
        signature: consentSignature,
      },
    );
    assert.equal(consented.status, 200, JSON.stringify(consented.value));
    const done = await published(live, session);
    assert.equal(done.record!.consented, true);

    const [record] = (await readRecords(live, learner.address)).filter(
      (a) => a.attemptId === start.body.attemptId,
    );
    assert(record, "attempt not on chain");
    assert.equal(record.verified, true, record.problems.join(", "));
    assert.equal(record.songKey, songKeyOf(manifest.song!));
    assert.deepEqual(
      { ...record.song, posts: record.song.posts.toLowerCase() },
      { ...manifest.song!, chainId: 6343 },
    );
    assert.equal(record.contentRevision, ticket.body.manifestSha256);
    assert.deepEqual(
      record.lines.map((l) => [l.lineId, l.status, l.scoreBps]),
      result.lines.map((l) => [l.lineId, l.status, l.scoreBps]),
    );
    assert.equal(record.completions.at(-1)!.status, "completed");

    // Purchases were redeemed on chain for every paid line, and the
    // provider heard the song through one stream per socket.
    const redeemed = (await live.operatorState("redemption:")).length;
    assert.equal(redeemed, manifest.segments.length - 1);
    // The ticket is settled, so a second take starts with a new ticket.
    const second = await ticketFor(live, session);
    assert.notEqual(second.ticket.body.ticketId, ticketId);
  } finally {
    await live.dispose();
  }
});

test("a MOSS account consents with an ERC-8010 activation and its grades publish", async () => {
  const { live, manifest } = await liveSong((m) => [stream(m)]);
  try {
    // A fresh account with no code, with a separate key standing in for its passkey.
    const learner = privateKeyToAccount(generatePrivateKey()),
      passkey = privateKeyToAccount(generatePrivateKey());
    const session = await live.signIn(learner);
    const { ticket, proof } = await ticketFor(live, session);
    const ticketId = ticket.body.ticketId;
    const socket = await connect(live, ticketId, proof);
    const start = socket.ready.attemptStart!;
    const offered = socket.ready.consent as {
      domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: Hex;
      };
      message: Consent;
    };
    const consentDigest = hashTypedData({
      domain: offered.domain,
      types: consentTypes,
      primaryType: "Consent",
      message: consentMessage(offered.message),
    });
    const wrapped = serializeErc8010Signature({
      authorization: await learner.signAuthorization({
        contractAddress: evm.mockAccount,
        chainId: 0,
        nonce: 0,
      }),
      address: evm.mockInitializer,
      data: encodeFunctionData({
        abi: parseAbi(["function activate(address account, address key)"]),
        functionName: "activate",
        args: [learner.address, passkey.address],
      }),
      signature: await passkey.sign({ hash: consentDigest }),
    });
    socket.send({ type: "consent", signature: wrapped });
    assert.equal((await socket.next()).type, "consented");
    for (const segment of manifest.segments) {
      const opens =
        start.body.startedAt +
        Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
      if (opens > live.now()) await live.at(opens);
      await buy(live, session, socket, ticketId, segment.segmentId, start);
    }
    await sing(
      socket,
      ticketId,
      start.body.attemptId,
      0,
      songEndMs(manifest) + 500,
    );
    // Finishing is the end of the performance, so it comes after the last line.
    await live.at(
      start.body.startedAt + Math.ceil(songEndMs(manifest) / 1000) - 1,
    );
    socket.send({ type: "finish" });
    await live.at(live.now() + PAYMENT_GRACE_S);
    socket.close();
    await finalResult(live, session);
    await published(live, session);
    const designator = `0xef0100${evm.mockAccount.slice(2).toLowerCase()}`;
    assert.equal(
      (
        (await evm.publicClient.getCode({ address: learner.address })) ?? ""
      ).toLowerCase(),
      designator,
    );
    const [record] = (await readRecords(live, learner.address)).filter(
      (a) => a.attemptId === start.body.attemptId,
    );
    assert(record, "attempt not on chain");
    assert.equal(record.verified, true, record.problems.join(", "));
    assert.equal(record.songKey, songKeyOf(manifest.song!));
    assert.equal(record.lines.length, manifest.lines.length);
  } finally {
    await live.dispose();
  }
});
