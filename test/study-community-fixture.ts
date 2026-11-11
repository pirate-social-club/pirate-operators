// Actual community routes, D1 migrations, signatures and V3 contract. The posts
// RPC, IPFS transport and speech provider below are explicit local simulations.
// With `v4`, a LearningResultsV4 contract is also deployed and is the
// directory's learning records; V3 stays configured for historical lessons.
import { readFile } from "node:fs/promises";
import { encodeFunctionData } from "viem";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { privateKeyToAccount } from "viem/accounts";
import { communityRuntime } from "./community-runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  communityFetch,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { studyOperatorRoute } from "../services/study-operator.ts";
import { acceptEnrollment } from "../services/learning-enrollment.ts";
import { authorizationRoute } from "../services/learning-authorization.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  relayPendingSignIns,
  requestSignInRelay,
} from "../services/learning-sign-in.ts";
import type {
  SiweChallenge,
  SignInChallenge,
} from "../packages/community/accounts.ts";
import type { Address } from "viem";
import type {
  StudyTranscriber,
  StudyTranscript,
} from "../packages/study/speech-transcriber.ts";

export async function studyCommunityFixture(
  port: number,
  options: { v4?: boolean } = {},
) {
  const f = await learningBindingFixture(port, firstSongFixture.communityId);
  let runtime: Awaited<ReturnType<typeof communityRuntime>> | undefined;
  try {
    runtime = await communityRuntime({ v4: options.v4 });
    const v4: Address | undefined = options.v4
      ? await f.evm.deploy("LearningResultsV4", [
          accounts[3].address,
          firstSongFixture.communityId,
          learningV4PublicityPolicy,
          firstSong.origin,
        ])
      : undefined;
    const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const deployment = async (file: string) =>
      JSON.parse(
        await readFile(
          new URL("../docs/deployments/" + file, import.meta.url),
          "utf8",
        ),
      ).configuration;
    const original = validateConfig({
      ...(await deployment("first-song-managed-20261105.configuration.json")),
      publisher: publisher.address.toLowerCase(),
    });
    const config = validateConfig(
      {
        ...(await deployment(
          "first-song-managed-20261105.curated-configuration.json",
        )),
        publisher: publisher.address.toLowerCase(),
        learningRecords: (v4 ?? f.v3).toLowerCase(),
      },
      [original],
    );
    const posts = releasePostsFixture(publisher, config);
    const p = firstSongFixture.post;
    await posts.client.sendRawTransaction({
      serializedTransaction: await publisher.signTransaction({
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
    let now = Number((await f.evm.publicClient.getBlock()).timestamp) * 1000;
    let calls = 0,
      observations = 0;
    let heard = "",
      loss: string | null = null,
      statusDown = false,
      sourceDown = false;
    let behavior: () => Promise<StudyTranscript> = async () => ({
      text: heard,
      language: "en",
    });
    const provider: StudyTranscriber = {
      providerRetention: "stored",
      async transcribe() {
        calls++;
        return behavior();
      },
    };
    f.env.RESULTS_V3_CONTRACT = f.v3;
    await f.evm.write(
      f.v3,
      "LearningResultsV3",
      "setGrader",
      [accounts[2].address, 2, true],
      3,
    );
    if (v4) {
      f.env.RESULTS_V4_CONTRACT = v4;
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "setGrader",
        [accounts[2].address, 2, true],
        3,
      );
    }
    let authorizationDown = false;
    f.env.ISSUER = accounts[1].address;
    f.env.SPEECH_BUDGET = {
      getByName(name: string) {
        if (name !== "elevenlabs-service")
          throw Error("wrong observation object");
        return {
          claim: async () => {
            observations++;
          },
        };
      },
    } as never;
    const store = {
      ...f.store,
      now: () => Math.floor(now / 1000),
      durableStudyWrite: async <T>(operation: () => T) =>
        f.store.transaction(operation),
    };
    const binding = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (statusDown && path === "/study/speech/status")
          throw Error("fixture status outage");
        if (authorizationDown && path.startsWith("/authorization"))
          throw Error("fixture authorization outage");
        // The operator's Study route, then its sign-in relay route.
        const response =
          (await studyOperatorRoute(request, f.env, store, provider)) ??
          (await authorizationRoute(request, f.env, store));
        if (path === loss) {
          loss = null;
          throw Error("fixture response lost");
        }
        return response!;
      },
    } as Fetcher;
    const env = {
      DB: runtime.db,
      MEDIA: runtime.media,
      JOBS: { send: async () => {} },
      ASSETS: { fetch: async () => new Response("fixture") },
      COMMUNITY_NAME: firstSong.name,
      PLAN_ID: firstSong.planId,
      APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
      CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
      COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
      KARAOKE_SERVICE_MODE: "internal",
      KARAOKE_OPERATOR: binding,
      KARAOKE_OPERATOR_ADDRESS: accounts[2].address,
      KARAOKE_SIGNER_PRIVATE_KEY: keys[1],
      KARAOKE_PAYMENT_CHAIN_ID: "31337",
      STUDY_RESULTS_V3_CONTRACT: f.v3,
      ...(v4 ? { STUDY_RESULTS_V4_CONTRACT: v4 } : {}),
    } as unknown as CommunityEnv;
    const ports: CommunityDependencies = {
      configuration: async () => config,
      verifyLogin: verifyLoginOffline,
      creatorHealth: async () => false,
      now: () => now,
      publicReads: {
        client: posts.client,
        profile: posts.profile,
        transport: async (request) => {
          if (sourceDown) throw Error("fixture source unavailable");
          const cid = new URL(request.url).pathname.split("/").pop();
          const bytes =
            cid === firstSongFixture.postUri.slice(7)
              ? firstSongFixture.postBytes
              : cid === firstSongFixture.lyricsUri.slice(7)
                ? firstSongFixture.lyricBytes
                : null;
          return bytes
            ? new Response(Uint8Array.from(bytes))
            : new Response("not_found", { status: 404 });
        },
      },
    };
    const call = (path: string, init: RequestInit = {}) =>
      communityFetch(new Request(firstSong.origin + path, init), env, ports);
    const post = (
      path: string,
      body: unknown,
      auth: Record<string, string> = {},
    ) =>
      call(path, {
        method: "POST",
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
          ...auth,
        },
        body: JSON.stringify(body),
      });
    return {
      ...f,
      v4: v4!,
      operatorEnv: f.env,
      db: runtime.db,
      env,
      config,
      ports,
      call,
      post,
      store,
      async login(index = 5) {
        const challenge = (await (
          await post("/api/auth/challenge", {
            address: accounts[index].address,
          })
        ).json()) as SiweChallenge | SignInChallenge;
        // Plain SIWE, or a V4 community's SIWE text that is also the
        // permission: either is signed as text.
        const response = await post("/api/auth/verify", {
          id: challenge.id,
          signature: await accounts[index].signMessage({
            message: challenge.message,
          }),
        });
        const session = (await response.json()) as { csrf: string };
        return {
          cookie: response.headers.get("set-cookie")!.split(";")[0],
          "x-csrf-token": session.csrf,
        };
      },
      async enroll(index = 5) {
        const enrollment = await f.enrollment(3, index);
        await acceptEnrollment(
          f.env,
          store,
          enrollment.e,
          enrollment.signature,
        );
        now = Number((await f.evm.publicClient.getBlock()).timestamp) * 1000;
      },
      /** The release step that selects V4: its sign-in schema, migration 0013. */
      applyV4Migration: () => runtime!.applyV4(),
      /**
       * V4: each pending sign-in is relayed as a learner's first Study or
       * Karaoke start requests it, and the scheduled relay settles the rest.
       */
      async recordSignIns() {
        const pending = await runtime!.db
          .prepare(
            "SELECT DISTINCT account_id FROM learning_authorizations WHERE state='pending'",
          )
          .all<{ account_id: string }>();
        for (const { account_id } of pending.results)
          await requestSignInRelay(env, runtime!.db, account_id, now);
        await relayPendingSignIns(env, runtime!.db, now);
      },
      authorizationDown: (value: boolean) => {
        authorizationDown = value;
      },
      counts: () => ({ calls, observations }),
      heard: (text: string) => {
        heard = text;
      },
      behavior: (next: typeof behavior) => {
        behavior = next;
      },
      lose: (path: string) => {
        loss = path;
      },
      statusDown: (value: boolean) => {
        statusDown = value;
      },
      sourceDown: (value: boolean) => {
        sourceDown = value;
      },
      advance: (ms: number) => {
        now += ms;
      },
      clock: () => now,
      async mineClock() {
        const head = Number((await f.evm.publicClient.getBlock()).timestamp);
        now = Math.max(now, (head + 1) * 1000);
        await f.evm.rpc("evm_setNextBlockTimestamp", [Math.floor(now / 1000)]);
        await f.evm.rpc("evm_mine", []);
      },
      async dispose() {
        await runtime!.dispose();
        await f.stop();
      },
    };
  } catch (error) {
    await runtime?.dispose();
    await f.stop();
    throw error;
  }
}
