// Actual Study start, new Karaoke ticket and connected admission, with real D1
// lesson/attempt CAS. Quote, posts RPC, IPFS and chain observation are explicit
// local fixtures. Fixed existing fixture keys only; no provider or new key.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeFunctionData, type Hex } from "viem";
import { accounts, keys } from "../harness/runtime.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { simulatedAlignment } from "../harness/karaoke-elevenlabs-simulator.ts";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { sign } from "../packages/protocol/index.ts";
import { newLesson, songOf } from "../packages/study/lesson.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { StudyAttemptStore } from "../packages/study/attempt-store.ts";
import { liveStudy, type StudyEnv } from "../services/study-community.ts";
import { karaokeTicket } from "../services/karaoke-community.ts";
import {
  connectedPracticeAuthorization,
  practiceAuthorization,
  publicResults,
} from "../services/learning-sign-in.ts";
import { closeWithdrawnStudyLessons } from "../services/learning-public-results.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import { communityRuntime } from "./community-runtime.ts";
import type { PublicReadPorts } from "../services/community-public.ts";
import type { OperatorQuote } from "../packages/protocol/payments.ts";

const id = `0x${"ab".repeat(32)}` as Hex,
  wallet = accounts[5].address.toLowerCase();
async function fixture() {
  const f = await communityRuntime({ v4: true });
  try {
    const communityId = firstSongFixture.communityId;
    await f.db
      .prepare(
        "INSERT INTO application_identity VALUES(1,?,'https://community.example')",
      )
      .bind(communityId)
      .run();
    await f.db
      .prepare(
        "INSERT INTO community_accounts VALUES('a','author-a',0),('b','author-b',0)",
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO credential_bindings VALUES('binding','a','moss',6343,?,0)",
      )
      .bind(wallet)
      .run();
    await f.db
      .prepare(
        `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
      VALUES(?,'a',?,'{}','','0x',?,4,100,'recorded',0,0)`,
      )
      .bind(id, wallet, id)
      .run();
    const raw = JSON.parse(
      await readFile(
        new URL(
          "../docs/deployments/first-song-managed-20261105.configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const original = validateConfig({
      ...raw.configuration,
      publisher: accounts[0].address.toLowerCase(),
    });
    const curated = JSON.parse(
      await readFile(
        new URL(
          "../docs/deployments/first-song-managed-20261105.curated-configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const config = validateConfig(
      {
        ...curated.configuration,
        publisher: accounts[0].address.toLowerCase(),
        learningRecords: accounts[3].address.toLowerCase(),
      },
      [original],
    );
    const posts = releasePostsFixture(accounts[0], config),
      p = firstSongFixture.post;
    await posts.client.sendRawTransaction({
      serializedTransaction: await accounts[0].signTransaction({
        chainId: 6343,
        type: "legacy",
        nonce: 3,
        gas: 300000n,
        gasPrice: 1000000n,
        to: config.postsContract,
        data: encodeFunctionData({
          abi: postsAbi,
          functionName: "publishRevision",
          args: [
            p.communityId,
            p.postId,
            0n,
            BigInt(p.configurationRevision),
            p.authorId,
            0,
            firstSongFixture.postSha256,
            firstSongFixture.postUri,
          ],
        }),
      }),
    });
    posts.mine();
    const ipfs = new Map<string, Uint8Array>([
      [firstSongFixture.lyricsUri.slice(7), firstSongFixture.lyricBytes],
      [firstSongFixture.postUri.slice(7), firstSongFixture.postBytes],
    ]);
    const reads: PublicReadPorts = {
      client: posts.client,
      profile: posts.profile,
      transport: async (request) => {
        const key = new URL(request.url).pathname.split("/").pop()!;
        const bytes = ipfs.get(key);
        assert.ok(bytes, "unexpected IPFS request");
        return new Response(new Uint8Array(bytes));
      },
      configurationHistory: async () => [original, config],
      manifestAvailable: async () => true,
    };
    const alignment = alignmentResult(
      simulatedAlignment(firstSongFixture.lyrics.sourceText, {
        mode: "characters",
        startMs: 1500,
        charMs: 10,
        spaceMs: 10,
        lineGapMs: 150,
      }),
      firstSongFixture.lyrics,
      120000,
    );
    await f.db
      .prepare(
        `INSERT INTO song_alignments(operation_id,community_id,post_id,lyrics_revision,grant_hash,request_hash,request_json,state,result_json)
      VALUES('fixture',?,?,1,?,?,'{}','complete',?)`,
      )
      .bind(
        communityId,
        firstSongFixture.postId,
        id,
        id,
        JSON.stringify(alignment),
      )
      .run();
    const quote: OperatorQuote = {
      serviceMode: "internal",
      operator: accounts[2].address,
      recipient: accounts[2].address,
      chainId: 6343,
      payments: config.operatorPayments,
      token: accounts[0].address,
      admissionPrice: "0",
      segmentPrice: "0",
      scoringPolicy: "fixture-policy",
      maxSegmentMs: 10000,
      maxUnpaidRun: 10,
      validFrom: 1,
      validUntil: 1000,
    };
    const signedQuote = await sign("quote", quote, keys[2], 6343);
    let observations = 0;
    const env: StudyEnv = {
      KARAOKE_SERVICE_MODE: "internal",
      KARAOKE_OPERATOR_ADDRESS: accounts[2].address,
      KARAOKE_OPERATOR_ORIGIN: "https://operator.example",
      KARAOKE_SIGNER_PRIVATE_KEY: keys[1],
      KARAOKE_COMMUNITY_ADDRESS: accounts[1].address,
      KARAOKE_PAYMENT_CHAIN_ID: "6343",
      KARAOKE_SIGNATURE_CHAIN_ID: "6343",
      KARAOKE_PAYMENT_TOKEN: quote.token,
      KARAOKE_RPC_URL: "http://fixture.invalid",
      STUDY_RESULTS_V4_CONTRACT: config.learningRecords,
      KARAOKE_OPERATOR: {
        async fetch(input, init) {
          const req = new Request(input, init),
            path = new URL(req.url).pathname;
          if (path === "/quote") return Response.json(signedQuote);
          assert.equal(path, `/authorization/${wallet}`);
          observations++;
          return Response.json({
            since: 0,
            revokedAt: 105,
            revocationNonce: "1",
          });
        },
        connect() {
          throw Error("no provider/socket in admission fixture");
        },
      },
    };
    const store = new StudyLessonStore(f.db),
      attempts = new StudyAttemptStore(f.db);
    const lines = firstSongFixture.lyrics.lines.map(
      (l: { lineId: string; text: string; language: string }) => ({
        chainId: 6343,
        postsContract: config.postsContract,
        communityId,
        postId: firstSongFixture.postId,
        lyricRevision: 1,
        lineVersion: 1,
        manifestDigest: firstSongFixture.lyricsSha256,
        ...l,
        language: "en",
      }),
    );
    const state = newLesson(songOf(lines[0]), lines.slice(0, 4), 100000),
      owner = { accountId: "a", communityId };
    const row = await store.create(owner, "existing-lesson-request", state);
    const take = await attempts.open(
      owner,
      "existing-attempt-request",
      lines[0],
      101000,
      { lessonId: row.lesson_id, presentationNumber: 1, takeNumber: 1 },
    );
    await store.update(owner, row, {
      ...state,
      currentAttemptId: take.attemptId,
    });
    const foreign = await store.create(
      { accountId: "b", communityId },
      "other-account-request",
      state,
    );
    return {
      ...f,
      env,
      config,
      reads,
      store,
      row,
      foreign,
      attempts,
      take,
      owner,
      state,
      observations: () => observations,
      ports: { env, config, reads, db: f.db, now: () => 110000 },
    };
  } catch (e) {
    await f.dispose();
    throw e;
  }
}
for (const path of [
  "Study start",
  "Karaoke new ticket",
  "connected learning",
] as const)
  test(`${path} records early revocation and closes existing lessons before refusing`, async () => {
    const f = await fixture();
    try {
      assert.equal(await publicResults(f.db, "a", true), "on");
      if (path === "Study start")
        await assert.rejects(
          liveStudy(f.ports, { account_id: "a", wallet }).start(
            "new-lesson-request",
            f.state.song,
          ),
          /study_authorization_required/,
        );
      else if (path === "Karaoke new ticket")
        await assert.rejects(
          karaokeTicket(
            f.ports,
            { account_id: "a", wallet },
            { postId: firstSongFixture.postId },
          ),
          /karaoke_authorization_required/,
        );
      else {
        const context = {
          communityId: f.config.communityId,
          botId: "123",
          generation: 1,
          startedAtMs: 110000,
        };
        assert.deepEqual(
          await connectedPracticeAuthorization(
            f.env,
            f.db,
            context,
            async () => ({
              version: 1,
              ...context,
              accountId: "a",
              wallet,
              linkedAtMs: 100000,
              revokedAtMs: null,
            }),
            110000,
          ),
          { id: null, pending: false },
        );
      }
      assert.equal(await publicResults(f.db, "a", true), "off");
      const closed = f.store.state(await f.store.row(f.owner, f.row.lesson_id));
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.completionReason, "consent_ended");
      assert.equal(
        (await f.attempts.get(f.owner, f.take.attemptId)).state,
        "unavailable",
      );
      assert.equal(
        f.store.state(
          await f.store.row(
            { accountId: "b", communityId: f.config.communityId },
            f.foreign.lesson_id,
          ),
        ).status,
        "active",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) n FROM study_lessons")
            .first<{ n: number }>()
        )?.n,
        2,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT count(*) n FROM karaoke_state WHERE key LIKE 'sessionSecret:%' OR key LIKE 'wallet:%'",
            )
            .first<{ n: number }>()
        )?.n,
        0,
      );
      assert.equal(
        f.observations(),
        1,
        "use the observed revocation; no second chain read can mask it",
      );
      await closeWithdrawnStudyLessons(f.db, "a", 110000); // Idempotent retries.
    } finally {
      await f.dispose();
    }
  });
test("a prior cleanup interruption is retried when admission already sees the local off flag", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare(
        "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES('a',105000,105000)",
      )
      .run();
    assert.deepEqual(
      await practiceAuthorization(f.env, f.db, "a", wallet, 110, 110000),
      { id: null, pending: false },
    );
    assert.equal(
      f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
      "abandoned",
    );
    assert.equal(f.observations(), 0);
  } finally {
    await f.dispose();
  }
});
