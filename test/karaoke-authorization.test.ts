// V4 Karaoke: the learner's sign-in is the publication permission. The
// community application, its D1 and the operator Worker with its audio socket
// run locally (harness/karaoke-live.ts) against a local LearningResultsV4;
// the posts RPC, IPFS and ElevenLabs are the harness's explicit simulations.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, hashMessage, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accounts, keys } from "../harness/runtime.ts";
import { chain } from "../harness/chain.ts";
import { openAttempt } from "../harness/karaoke-client.ts";
import {
  expectedKaraoke,
  firstSongFixture,
  karaokeLive,
  sungStream,
  type KaraokeLive,
} from "../harness/karaoke-live.ts";
import type { SimulatedAlignment } from "../harness/karaoke-elevenlabs-simulator.ts";
import { digest, sign, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  quoteIdOf,
  type KaraokeManifest,
  type OperatorQuote,
} from "../packages/protocol/payments.ts";
import {
  resultsV4Abi,
  readSignInMessageV4,
  signInMessageV4,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { readPublicResults } from "../packages/records/results-v3.ts";
import type { SignInChallenge } from "../packages/community/accounts.ts";
import type { BoundAuthorization } from "../services/study-authorization.ts";

/** The browser journey's quick alignment: the song is sung in about twenty seconds. */
const ALIGNMENT: SimulatedAlignment = {
  mode: "characters",
  startMs: 1500,
  charMs: 10,
  spaceMs: 10,
  lineGapMs: 150,
};
const STEM_MS = 30000;

type Live = KaraokeLive;
type Session = Awaited<ReturnType<Live["signIn"]>>;
type Evm = Awaited<ReturnType<typeof chain>>;
let evm: Evm, live: Live, timed: KaraokeManifest;

before(async () => {
  evm = await chain(19991);
  const manifest = await expectedKaraoke(ALIGNMENT, STEM_MS);
  live = await karaokeLive({
    evm,
    resultsV4: true,
    now: Number((await evm.publicClient.getBlock()).timestamp) + 1,
    alignment: ALIGNMENT,
    stemMs: STEM_MS,
    streams: Array.from({ length: 12 }, () => sungStream(manifest)),
  });
  await live.publish();
  assert.equal((await live.align()).value.state, "complete");
  // Both clocks and the chain agree before anyone signs in.
  await live.at(live.now());
  timed = (
    await live.get<KaraokeManifest>(
      null,
      `/api/public/posts/${firstSongFixture.postId}/karaoke`,
    )
  ).value;
  assert.deepEqual(timed, manifest);
});
after(async () => {
  await live?.dispose();
  evm?.child.kill();
});

const v4 = () => live.resultsV4!;
const readV4 = <T>(functionName: string, args: unknown[]) =>
  evm.publicClient.readContract({
    address: v4(),
    abi: resultsV4Abi,
    functionName,
    args,
  } as never) as Promise<T>;
/** The learner's sign-in rows as the application stored them. */
const authorizations = async (learner: Address) =>
  (
    await live.db
      .prepare(
        "SELECT authorization_id,issued_at,state FROM learning_authorizations WHERE subject=? ORDER BY issued_at",
      )
      .bind(learner.toLowerCase())
      .all<{ authorization_id: Hex; issued_at: number; state: string }>()
  ).results;
/** Signs in through the application and lets the scheduled relay record it. */
async function signIn(index: number) {
  const session = await live.signIn(accounts[index]!);
  for (
    let i = 0;
    i < 5 && (await authorizations(accounts[index]!.address))[0]?.state !== "recorded";
    i++
  )
    await live.recordSignIns();
  const [recorded] = await authorizations(accounts[index]!.address);
  assert.equal(recorded?.state, "recorded");
  return { session, authorization: recorded! };
}
/**
 * A later sign-in recorded on chain directly through the operator's relay
 * route. The application stores no second row for an account already on.
 * While the account's public results are off the application gives only the
 * plain login, so with `outside` the learner's V4 text is built here, as one
 * signed outside the application.
 */
async function laterSignInOnChain(index: number, outside = false) {
  const challenge = (
    await live.json<SignInChallenge>(
      await live.app("/api/auth/challenge", {
        method: "POST",
        headers: {
          origin: new URL(live.config.app.origin).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: accounts[index]!.address }),
      }),
    )
  ).value;
  if (outside) {
    assert.equal(challenge.kind, undefined);
    assert.equal(readSignInMessageV4(challenge.message), undefined);
    challenge.message = signInMessageV4(
      {
        origin: firstSong.origin,
        chainId: 31337,
        contract: v4().toLowerCase() as Address,
        communityId: live.config.communityId,
        publicationPolicy: learningV4PublicityPolicy,
      },
      { learner: accounts[index]!.address, nonce: digest(`outside-${live.now()}`), issuedAt: BigInt(live.now()) },
    );
  } else assert.equal(challenge.kind, "sign-in-v4");
  const signature = await accounts[index]!.signMessage({ message: challenge.message });
  const message: SignIn = readSignInMessageV4(challenge.message)!.signIn;
  let state = "pending";
  for (let i = 0; i < 5 && state !== "success"; i++)
    state = (
      (await (
        await live.operator.fetch("http://service/authorization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signIn: { ...message, issuedAt: String(message.issuedAt) },
            signature,
          }),
        })
      ).json()) as { state: string }
    ).state;
  assert.equal(state, "success");
  return { id: hashMessage(challenge.message), issuedAt: Number(message.issuedAt) };
}
const ticket = (session: Session) =>
  live.post<{
    ticket: Signed<Ticket>;
    proof: Hex;
    error?: string;
  }>(session, "/api/karaoke/tickets", { postId: firstSongFixture.postId });
/** As the page does: a finished take is released first, then a ticket is issued. */
async function issued(session: Session) {
  await live.get(session, `/api/karaoke/attempt?postId=${firstSongFixture.postId}`);
  const response = await ticket(session);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}
const operatorValue = async <T>(key: string) =>
  (await live.operatorState(key)).find((row) => row.key === key)?.value as
    | T
    | undefined;
const binding = (ticketId: Hex) =>
  operatorValue<BoundAuthorization>(`ticketAuthorization:${ticketId}`);
const publication = (ticketId: Hex) =>
  operatorValue<{ state: string; reason?: string }>(`publicationV2:${ticketId}`);
/** Advances both clocks until the run's final result is published or kept private. */
async function settled(ticketId: Hex) {
  for (let i = 0; i < 60; i++) {
    await live.at(live.now() + 2);
    const state = await publication(ticketId);
    if (state && state.state !== "pending") return state;
  }
  throw new Error(`publication_unsettled:${JSON.stringify(await publication(ticketId))}`);
}
/** The take's socket; `stopEarly` leaves after a few seconds, as a learner who exits. */
async function sing(ticketId: Hex, proof: Hex, stopEarly = false) {
  const socket = await openAttempt(live.mf, ticketId, { proof });
  assert(!("refused" in socket), JSON.stringify(socket));
  if (stopEarly) {
    await live.at(live.now() + 3);
    socket.close();
  }
  return socket;
}
/** Every public result on the V4 contract, read and verified independently. */
async function publicResults() {
  return readPublicResults(
    {
      contract: v4(),
      codeHash: keccak256((await evm.publicClient.getCode({ address: v4() }))!),
      version: 4,
    },
    {
      rpcUrl: evm.rpcUrl,
      chainId: 31337,
      communityId: live.config.communityId,
      fromBlock: 0n,
      toBlock: await evm.publicClient.getBlockNumber({ cacheTime: 0 }),
      karaokeManifest: async (revision) =>
        digest(timed) === revision ? timed : undefined,
      authenticateKaraoke: async (candidate) =>
        candidate.source?.lyricsSha256 === timed.source?.lyricsSha256 &&
        candidate.lines.length === timed.lines.length,
    },
  );
}
const resultsOf = async (learner: Address) =>
  (await publicResults()).filter(
    (r) => r.result.learner.toLowerCase() === learner.toLowerCase(),
  );
/** An issuer-signed ticket for the operator, as the community application signs one. */
async function craftedTicket(learner: Address, authorizationId: Hex) {
  const quote = (await (
    await live.operator.fetch("http://service/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).json()) as Signed<OperatorQuote>;
  const now = live.now();
  const body: Ticket = {
    ticketId: digest({ crafted: crypto.randomUUID() }) as Hex,
    communityId: live.config.communityId,
    participant: learner,
    songHash: timed.songHash,
    manifestSha256: digest(timed) as Hex,
    sessionKey: accounts[0]!.address,
    operator: accounts[2]!.address.toLowerCase() as Address,
    quoteId: quoteIdOf(quote.body),
    community: accounts[3]!.address,
    mode: "performance",
    maxPaidSegments: timed.segments.length,
    maxDurationMs: timed.segments.at(-1)!.endMs + 5000,
    issuedAt: now,
    expiresAt: now + 300,
    authorizationId,
  };
  const response = await live.operator.fetch("http://service/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticket: await sign("ticket", body, keys[1]!, 31337),
      manifest: timed,
    }),
  });
  return {
    ticketId: body.ticketId,
    status: response.status,
    value: (await response.json()) as { prepared?: boolean; error?: string },
  };
}

test("a V4 run binds the recorded sign-in with no enrollment and publishes on chain as version 4", async () => {
  const { session, authorization } = await signIn(5);
  assert.equal(
    await readV4<bigint>("authorizedSince", [accounts[5]!.address]),
    BigInt(authorization.issued_at),
  );
  const take = await issued(session);
  const ticketId = take.ticket.body.ticketId;
  // The community's signed ticket names the sign-in; the operator bound it.
  assert.equal(take.ticket.body.authorizationId, authorization.authorization_id);
  assert.deepEqual(await binding(ticketId), {
    id: authorization.authorization_id,
    issuedAt: authorization.issued_at,
    target: { chainId: 31337, version: 4, contract: v4().toLowerCase() },
  });
  assert.equal(await operatorValue(`enrollment:${ticketId}`), undefined);
  assert.equal((await live.operatorState("pendingEnrollment:")).length, 0);
  await sing(ticketId, take.proof);
  const published = await settled(ticketId);
  assert.deepEqual(published.state, "published", JSON.stringify(published));
  // The transaction published to V4 with the authorization as enrollmentId.
  const work = (await live.operatorState(`workV2:${ticketId}:1`))[0]!.value as {
    target: { version: number; contract: string };
    data: Hex;
  };
  assert.equal(work.target.version, 4);
  assert.equal(work.target.contract, v4().toLowerCase());
  const call = decodeFunctionData({ abi: resultsV4Abi, data: work.data });
  assert.equal(call.functionName, "publish");
  const [result] = await resultsOf(accounts[5]!.address);
  assert.ok(result);
  assert.equal(result.verified, true, result.problems.join(", "));
  assert.equal(result.result.enrollmentId, authorization.authorization_id);
  assert.equal(result.result.activity, 1);
  assert.equal(result.result.status, 1);
  assert.equal(result.result.sessionId, digest(ticketId));
  // The learner's screen reads the same publication through the application.
  const view = await live.get<{
    state: string;
    record: { publication: { state: string } | null };
  }>(session, `/api/karaoke/attempt?postId=${firstSongFixture.postId}`);
  assert.equal(view.value.state, "finished");
  assert.equal(view.value.record.publication?.state, "published");
});

test("a V4 run stopped early still publishes its final result", async () => {
  const { session } = await signIn(6);
  const take = await issued(session);
  await sing(take.ticket.body.ticketId, take.proof, true);
  const published = await settled(take.ticket.body.ticketId);
  assert.equal(published.state, "published", JSON.stringify(published));
  const [result] = await resultsOf(accounts[6]!.address);
  assert.equal(result!.verified, true, result!.problems.join(", "));
  // Abandoned, not completed: the stopped run is public as it ended.
  assert.equal(result!.result.status, 2);
});

test("a later sign-in never strands a run bound to an earlier one", async () => {
  const [first] = await authorizations(accounts[6]!.address);
  const session = await live.signIn(accounts[6]!);
  const take = await issued(session);
  const ticketId = take.ticket.body.ticketId;
  assert.equal((await binding(ticketId))!.id, first!.authorization_id);
  await sing(ticketId, take.proof);
  await live.at(live.now() + 2);
  const later = await laterSignInOnChain(6);
  assert.notEqual(later.id, first!.authorization_id);
  assert.ok(later.issuedAt > first!.issued_at);
  // Permission still starts at the first sign-in.
  assert.equal(
    await readV4<bigint>("authorizedSince", [accounts[6]!.address]),
    BigInt(first!.issued_at),
  );
  const published = await settled(ticketId);
  assert.equal(published.state, "published", JSON.stringify(published));
  const results = await resultsOf(accounts[6]!.address);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.verified, true, result.problems.join(", "));
    assert.equal(result.result.enrollmentId, first!.authorization_id);
  }
  // An operator check of the later sign-in also binds, as it is unbroken.
  const crafted = await craftedTicket(accounts[6]!.address, later.id);
  assert.equal(crafted.status, 200, JSON.stringify(crafted.value));
  assert.equal((await binding(crafted.ticketId))!.id, later.id);
});

test("a ticket waits while the sign-in is being recorded, then the same request succeeds", async () => {
  const real = live.env.KARAOKE_OPERATOR!;
  live.env.KARAOKE_OPERATOR = {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/authorization" && request.method === "POST")
        return Promise.reject(new Error("fixture authorization outage"));
      return real.fetch(input as never, init as never);
    },
  } as Fetcher;
  let session: Session, refused: Awaited<ReturnType<typeof ticket>>;
  try {
    session = await live.signIn(accounts[7]!);
    assert.equal((await authorizations(accounts[7]!.address))[0]!.state, "pending");
    // The first ticket relays the sign-in inline; the relay is out.
    refused = await ticket(session);
  } finally {
    live.env.KARAOKE_OPERATOR = real;
  }
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.value, { error: "karaoke_authorization_pending" });
  // Refused before any ticket, session key or operator work.
  const stateRows = async () =>
    (await live.db
      .prepare("SELECT count(*) AS n FROM karaoke_state")
      .first<{ n: number }>())!.n;
  const rows = await stateRows();
  assert.equal(
    (await live.db
      .prepare("SELECT count(*) AS n FROM karaoke_state WHERE lower(key)=?")
      .bind(`wallet:${accounts[7]!.address.toLowerCase()}`)
      .first<{ n: number }>())!.n,
    0,
  );
  assert.equal(await stateRows(), rows);
  for (
    let i = 0;
    i < 5 && (await authorizations(accounts[7]!.address))[0]!.state !== "recorded";
    i++
  )
    await live.recordSignIns();
  const [recorded] = await authorizations(accounts[7]!.address);
  assert.equal(recorded!.state, "recorded");
  const take = await issued(session);
  assert.equal(take.ticket.body.authorizationId, recorded!.authorization_id);
  assert.equal(
    (await binding(take.ticket.body.ticketId))!.id,
    recorded!.authorization_id,
  );
  // A session with no sign-in authorization is refused, not left pending.
  await live.db
    .prepare("UPDATE learning_authorizations SET state='refused' WHERE subject=?")
    .bind(accounts[7]!.address.toLowerCase())
    .run();
  await sing(take.ticket.body.ticketId, take.proof, true);
  assert.equal((await settled(take.ticket.body.ticketId)).state, "published");
  // The finished take is released first, so this is a new run.
  await live.get(session, `/api/karaoke/attempt?postId=${firstSongFixture.postId}`);
  const none = await ticket(session);
  assert.equal(none.status, 409);
  assert.deepEqual(none.value, { error: "karaoke_authorization_required" });
});

test("an on-chain revoke keeps an unpublished run private and refuses new and pre-revocation runs", async () => {
  const { session, authorization } = await signIn(8);
  const take = await issued(session);
  const ticketId = take.ticket.body.ticketId;
  const prepared = await issued(session).catch(() => undefined);
  assert.equal(prepared?.ticket.body.ticketId, ticketId, "a retry returns the open ticket");
  await sing(ticketId, take.proof, true);
  const reservation = async () =>
    operatorValue<{ state: string }>(`sponsor:reservation:record_result:${ticketId}:1`);
  assert.equal((await reservation())?.state, "reserved");
  // Withdrawn on chain before the stopped run's result is sent.
  await evm.write(v4(), "LearningResultsV4", "revoke", [accounts[8]!.address, 0n, "0x"], 8);
  const kept = await settled(ticketId);
  assert.deepEqual(kept, { state: "private", revision: 1, reason: "authorization_withdrawn" });
  assert.equal(
    (await live.operatorState("intent:")).some(({ key }) => key.includes(`${ticketId}:1`)),
    false,
  );
  assert.equal((await reservation())?.state, "released");
  assert.equal((await resultsOf(accounts[8]!.address)).length, 0);
  // A new run under the sign-in from before the withdrawal is refused.
  const refused = await ticket(session);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.value, { error: "karaoke_authorization_required" });
  // The withdrawal made outside the application is noticed: settings show
  // "off", and a sign-in through the application stores nothing to relay.
  const view = await live.get<{ publicResults: string }>(session, "/api/session");
  assert.equal(view.value.publicResults, "off");
  await live.signIn(accounts[8]!);
  assert.equal((await authorizations(accounts[8]!.address)).length, 1);
  const before = await craftedTicket(accounts[8]!.address, authorization.authorization_id);
  assert.equal(before.status, 400);
  assert.equal(before.value.error, "karaoke_authorization_required");
  // A sign-in after the withdrawal binds; the earlier one still does not.
  await live.at(live.now() + 2);
  const after = await laterSignInOnChain(8, true);
  const renewed = await craftedTicket(accounts[8]!.address, after.id);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.value));
  const stale = await craftedTicket(accounts[8]!.address, authorization.authorization_id);
  assert.equal(stale.value.error, "karaoke_authorization_required");
});

test("the operator refuses another learner's authorization, an unknown one, or one withdrawn before the run starts", async () => {
  const [other] = await authorizations(accounts[5]!.address);
  const mismatch = await craftedTicket(accounts[6]!.address, other!.authorization_id);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.value.error, "karaoke_authorization_mismatch");
  const unknown = await craftedTicket(accounts[6]!.address, `0x${"ab".repeat(32)}`);
  assert.equal(unknown.value.error, "karaoke_authorization_mismatch");
  assert.equal(await binding(mismatch.ticketId), undefined);
  assert.equal(await binding(unknown.ticketId), undefined);
  // Prepared under a live sign-in, then withdrawn before the socket opens.
  const { session } = await signIn(4);
  const take = await issued(session);
  await evm.write(v4(), "LearningResultsV4", "revoke", [accounts[4]!.address, 0n, "0x"], 4);
  const socket = await openAttempt(live.mf, take.ticket.body.ticketId, {
    proof: take.proof,
  });
  assert.ok("refused" in socket);
  assert.equal(socket.refused?.error, "karaoke_authorization_required");
  assert.equal(await operatorValue(`attempt:${take.ticket.body.ticketId}`), undefined);
});

test("settings turn public results off and back on: runs are refused while off and a new sign-in binds new runs", async () => {
  // A fresh public fixture learner; signatures only, never funded.
  const learner = privateKeyToAccount(generatePrivateKey());
  const session = await live.signIn(learner);
  for (let i = 0; i < 5 && (await authorizations(learner.address))[0]?.state !== "recorded"; i++)
    await live.recordSignIns();
  const [first] = await authorizations(learner.address);
  assert.equal(first?.state, "recorded");
  const before = await issued(session);
  assert.equal((await binding(before.ticket.body.ticketId))!.id, first!.authorization_id);
  await sing(before.ticket.body.ticketId, before.proof, true);
  assert.equal((await settled(before.ticket.body.ticketId)).state, "published");
  // "Turn off public results": the learner signs the V4 Revocation once.
  const request = await live.post<{
    target: { version: number };
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: "Revocation";
    message: { learner: Address; nonce: string };
  }>(session, "/api/learning/public-results/off", {});
  assert.equal(request.status, 200, JSON.stringify(request.value));
  assert.equal(request.value.target.version, 4);
  assert.equal(String(request.value.domain.verifyingContract).toLowerCase(), v4().toLowerCase());
  const signature = await learner.signTypedData(request.value as never);
  let off = { state: "pending", publicResults: "" };
  for (let i = 0; i < 5 && off.state !== "success"; i++) {
    const relayed = await live.post<typeof off>(session, "/api/learning/public-results/off", {
      message: request.value.message,
      signature,
    });
    assert.equal(relayed.status, 200, JSON.stringify(relayed.value));
    off = relayed.value;
    if (off.state !== "success") await live.at(live.now() + 1);
  }
  assert.deepEqual(off, { state: "success", publicResults: "off" });
  assert.equal(await readV4<bigint>("authorizedSince", [learner.address]), 0n);
  // New runs are refused, before any operator work.
  await live.get(session, `/api/karaoke/attempt?postId=${firstSongFixture.postId}`);
  const refused = await ticket(session);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.value, { error: "karaoke_authorization_required" });
  // Signing in while off records nothing.
  const whileOff = await live.signIn(learner);
  assert.equal((await authorizations(learner.address)).length, 1);
  // "Turn on public results", then the normal sign-in is relayed.
  const on = await live.post<{ publicResults: string }>(whileOff, "/api/learning/public-results/on", {});
  assert.deepEqual(on.value, { publicResults: "off" });
  // After the revocation's block: a sign-in at or before it never authorizes.
  const head = Number((await evm.publicClient.getBlock()).timestamp);
  await live.at(Math.max(live.now(), head) + 2);
  const renewed = await live.signIn(learner);
  for (let i = 0; i < 5 && (await authorizations(learner.address))[1]?.state !== "recorded"; i++)
    await live.recordSignIns();
  const [, second] = await authorizations(learner.address);
  assert.equal(second?.state, "recorded");
  assert.equal(await readV4<bigint>("authorizedSince", [learner.address]), BigInt(second!.issued_at));
  const view = await live.get<{ publicResults: string }>(renewed, "/api/session");
  assert.equal(view.value.publicResults, "on");
  const take = await issued(renewed);
  assert.notEqual(take.ticket.body.ticketId, before.ticket.body.ticketId);
  assert.equal(take.ticket.body.authorizationId, second!.authorization_id);
  assert.equal((await binding(take.ticket.body.ticketId))!.id, second!.authorization_id);
});
