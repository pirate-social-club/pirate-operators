// The V4 sign-in relay on a local chain: the application issues the SignIn
// challenge, a real viem typed-data signature signs in, and the operator's
// acceptAuthorization records it with LearningResultsV4.authorize. Explicit
// local contracts, fixture keys and journals; no public network or provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import { chain } from "../harness/chain.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { verifyLoginOnChain } from "../harness/login-verifier.ts";
import { stopChain } from "./payments-fixture.ts";
import { communityRuntime } from "./community-runtime.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import {
  communityFetch,
  communityScheduled,
  type CommunityDependencies,
  type CommunityEnv,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import type { SignInChallenge } from "../packages/community/accounts.ts";
import {
  resultsV4Abi,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  acceptAuthorization,
  authorizationRoute,
  AUTHORIZATION_RELAY_WINDOW_S,
  resumeAuthorizations,
} from "../services/learning-authorization.ts";
import { SIGN_IN_RELAY_WINDOW_S } from "../services/learning-sign-in.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";

const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
const deployment = JSON.parse(
  await readFile(
    new URL(
      "../docs/deployments/first-song-managed-20261105.configuration.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function fixture(port: number) {
  const evm = await chain(port);
  const runtime = await communityRuntime({ v4: true }).catch(async (error) => {
    await stopChain(evm);
    throw error;
  });
  const communityId = firstSong.directoryProfile.communityId;
  const v4 = await evm.deploy("LearningResultsV4", [
    accounts[3].address,
    communityId,
    learningV4PublicityPolicy,
  ]);
  let now = 0;
  const sync = async () => {
    now = Number((await evm.publicClient.getBlock()).timestamp);
  };
  /** Mines a block `seconds` later; both services use chain time. */
  const advance = async (seconds: number) => {
    await evm.rpc("evm_setNextBlockTimestamp", [now + seconds]);
    await evm.rpc("evm_mine", []);
    await sync();
  };
  await sync();
  let rows = new Map<string, unknown>();
  const store: ResultStore = {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: (key, value) => {
      rows.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: (key) => {
      rows.delete(key);
    },
    entries: (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T) => {
      const prior = new Map(rows);
      try {
        return fn();
      } catch (error) {
        rows = prior;
        throw error;
      }
    },
    now: () => now,
  };
  const operatorEnv = {
    RPC_URL: evm.rpcUrl,
    PAYMENT_CHAIN_ID: "31337",
    RESULTS_V4_CONTRACT: v4,
    COMMUNITY_ID: communityId,
    OPERATOR_ADDRESS: accounts[2].address,
    PRIVATE_KEY: keys[2],
    SERVICE_MODE: "internal",
    SPONSOR_CAP_WEI: "1000000000000000000",
    SPONSOR_GAS_PRICE_WEI: "10000000000",
    SPONSOR_GAS_LIMIT: "2000000",
    SPONSOR_DATA_FEE_WEI: "0",
    ACCOUNT_DELEGATE: evm.mockAccount,
    ACCOUNT_INITIALIZER: evm.mockInitializer,
  } as Env;
  let operatorDown = false;
  const relayed: string[] = [];
  const operator = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      relayed.push(`${request.method} ${new URL(request.url).pathname}`);
      if (operatorDown) throw new Error("fixture operator outage");
      return (
        // The operator's own route, as karaokeRoute dispatches it.
        (await authorizationRoute(request, operatorEnv, store)) ??
        new Response("not_found", { status: 404 })
      );
    },
  } as Fetcher;
  const config = validateConfig({
    ...deployment.configuration,
    publisher: publisher.address.toLowerCase(),
    learningRecords: v4.toLowerCase(),
  });
  const posts = releasePostsFixture(publisher, config);
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
    KARAOKE_OPERATOR: operator,
    KARAOKE_PAYMENT_CHAIN_ID: "31337",
    STUDY_RESULTS_V4_CONTRACT: v4,
  } as unknown as CommunityEnv;
  const ports: CommunityDependencies = {
    configuration: async () => config,
    // Through the chain, as the deployed application verifies on MegaETH.
    verifyLogin: verifyLoginOnChain(evm.publicClient),
    creatorHealth: async () => false,
    publicReads: { client: posts.client, profile: posts.profile },
    now: () => now * 1000,
  };
  const call = (path: string, init: RequestInit = {}) =>
    communityFetch(new Request(firstSong.origin + path, init), env, ports);
  const post = (path: string, body: unknown, more: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: {
        origin: firstSong.origin,
        "content-type": "application/json",
        ...more,
      },
      body: JSON.stringify(body),
    });
  const read = <T>(functionName: string, args: unknown[]) =>
    evm.publicClient.readContract({
      address: v4,
      abi: resultsV4Abi,
      functionName,
      args,
    } as never) as Promise<T>;
  /** The browser's sign-in: one typed signature over the challenge as received. */
  async function signIn(account: PrivateKeyAccount) {
    const challenge = (await (
      await post("/api/auth/challenge", { address: account.address })
    ).json()) as SignInChallenge;
    assert.equal(challenge.kind, "sign-in-v4");
    const signature = await account.signTypedData({
      ...challenge.typedData,
      message: challenge.typedData.message as never,
    });
    const verified = await post("/api/auth/verify", {
      id: challenge.id,
      signature,
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    const message: SignIn = {
      ...challenge.typedData.message,
      issuedAt: BigInt(challenge.typedData.message.issuedAt),
      expiresAt: BigInt(challenge.typedData.message.expiresAt),
    };
    return {
      message,
      signature,
      id: signInIdV4(31337, v4, message),
      auth: { cookie: verified.headers.get("set-cookie")!.split(";")[0]! },
    };
  }
  const authorization = (id: Hex) =>
    runtime.db
      .prepare(
        "SELECT state,tx_hash,policy_version FROM learning_authorizations WHERE authorization_id=?",
      )
      .bind(id)
      .first<{ state: string; tx_hash: string | null; policy_version: number }>();
  const session = async (auth: Record<string, string>) =>
    (await (await call("/api/session", { headers: auth })).json()) as {
      publicResults: string;
    };
  return {
    evm,
    v4,
    db: runtime.db,
    env,
    operatorEnv,
    ports,
    store,
    relayed,
    now: () => now,
    advance,
    sync,
    setOperatorDown: (down: boolean) => {
      operatorDown = down;
    },
    read,
    signIn,
    authorization,
    session,
    scheduled: () => communityScheduled(env, ports),
    count: (prefix: string) => store.entries(prefix).length,
    async stop() {
      await runtime.dispose();
      await stopChain(evm);
    },
  };
}

test(
  "a V4 sign-in is relayed, recorded on chain once, and reported as public results",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19971);
    try {
      const learner = accounts[5];
      const s = await f.signIn(learner);
      // The sign-in relayed at once; a scheduled pass settles any late receipt.
      assert.deepEqual(f.relayed, ["POST /authorization"]);
      await f.scheduled();
      const row = (await f.authorization(s.id))!;
      assert.equal(row.state, "recorded");
      assert.equal(row.policy_version, 4);
      assert.equal(
        String(await f.read("authorizationLearner", [s.id])).toLowerCase(),
        learner.address.toLowerCase(),
      );
      assert.equal(
        await f.read("authorizedSince", [learner.address]),
        s.message.issuedAt,
      );
      assert.equal(
        await f.read("authorizationIssuedAt", [s.id]),
        s.message.issuedAt,
      );
      const sent = f.store.entries("tx:").map(({ value }) => value as {
        kind: string;
        ref: string;
        hash: Hex;
        mined: { status: string } | null;
      });
      assert.deepEqual(
        sent.map((t) => [t.kind, t.ref, t.mined?.status]),
        [["record_authorize", s.id, "success"]],
      );
      assert.equal(row.tx_hash, sent[0]!.hash);
      assert.equal(f.count("pendingAuthorization:"), 0);
      assert.equal((await f.session(s.auth)).publicResults, "on");
      // Idempotent per authorization id: the same transaction, never another.
      for (let i = 0; i < 2; i++) {
        const again = await acceptAuthorization(
          f.operatorEnv,
          f.store,
          s.message,
          s.signature,
        );
        assert.deepEqual(again, {
          id: s.id,
          state: "success",
          txHash: sent[0]!.hash,
        });
      }
      const routed = (await (
        await (f.env.KARAOKE_OPERATOR as Fetcher).fetch(
          "http://service/authorization",
          {
            method: "POST",
            body: JSON.stringify({
              signIn: {
                ...s.message,
                issuedAt: String(s.message.issuedAt),
                expiresAt: String(s.message.expiresAt),
              },
              signature: s.signature,
            }),
          },
        )
      ).json()) as { id: Hex; state: string; txHash: Hex };
      assert.deepEqual(routed, {
        id: s.id,
        state: "success",
        txHash: sent[0]!.hash,
      });
      await resumeAuthorizations(f.operatorEnv, f.store);
      assert.equal(f.count("tx:"), 1);
      assert.equal(f.count("intent:record_authorize:"), 1);
      assert.equal(f.count("sponsor:reservation:record_authorize:"), 1);
      // The application reads live permission from the operator.
      const live = (await (
        await (f.env.KARAOKE_OPERATOR as Fetcher).fetch(
          `http://service/authorization/${learner.address}`,
        )
      ).json()) as { since: number; revokedAt: number };
      assert.deepEqual(live, {
        since: Number(s.message.issuedAt),
        revokedAt: 0,
      });
      // A later sign-in by the same learner needs no relay.
      f.relayed.length = 0;
      await f.advance(5);
      await f.signIn(learner);
      assert.deepEqual(f.relayed, []);
      // A sign-in someone else already relayed needs no operator transaction.
      const other = accounts[6];
      f.setOperatorDown(true);
      const t = await f.signIn(other);
      f.setOperatorDown(false);
      assert.equal((await f.authorization(t.id))!.state, "pending");
      assert.equal((await f.session(t.auth)).publicResults, "pending");
      await f.evm.write(
        f.v4,
        "LearningResultsV4",
        "authorize",
        [t.message, t.signature],
        0,
      );
      await f.sync();
      await f.scheduled();
      assert.deepEqual(await f.authorization(t.id), {
        state: "recorded",
        tx_hash: null,
        policy_version: 4,
      });
      assert.equal(f.count("tx:"), 1);
    } finally {
      await f.stop();
    }
  },
);

test(
  "the thirty-day relay window is a hard limit; the learner simply signs in again",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19972);
    try {
      // The operator's and the application's windows are the contract's.
      assert.equal(
        await f.read("RELAY_WINDOW", []),
        BigInt(AUTHORIZATION_RELAY_WINDOW_S),
      );
      assert.equal(SIGN_IN_RELAY_WINDOW_S, AUTHORIZATION_RELAY_WINDOW_S);
      assert.equal(AUTHORIZATION_RELAY_WINDOW_S, 30 * 86400);
      const learner = accounts[5];
      f.setOperatorDown(true);
      const s = await f.signIn(learner);
      await f.scheduled();
      assert.equal((await f.authorization(s.id))!.state, "pending");
      f.setOperatorDown(false);
      await f.advance(AUTHORIZATION_RELAY_WINDOW_S + 60);
      // The chain refuses it even when the operator's clock lags behind.
      const lagging = { ...f.store, now: () => Number(s.message.issuedAt) };
      await assert.rejects(
        acceptAuthorization(f.operatorEnv, lagging, s.message, s.signature),
        /^Error: stale_sign_in$/,
      );
      await assert.rejects(
        acceptAuthorization(f.operatorEnv, f.store, s.message, s.signature),
        /stale_sign_in/,
      );
      assert.equal(f.count("intent:"), 0);
      assert.equal(f.count("sponsor:reservation:"), 0);
      assert.equal(f.count("pendingAuthorization:"), 0);
      await f.scheduled();
      assert.deepEqual(await f.authorization(s.id), {
        state: "refused",
        tx_hash: null,
        policy_version: 4,
      });
      assert.equal((await f.session(s.auth)).publicResults, "off");
      assert.equal(await f.read("authorizedSince", [learner.address]), 0n);
      // Signing in again is a fresh authorization, recorded normally.
      const again = await f.signIn(learner);
      await f.scheduled();
      assert.equal((await f.authorization(again.id))!.state, "recorded");
      assert.equal((await f.session(again.auth)).publicResults, "on");
      assert.equal(
        await f.read("authorizedSince", [learner.address]),
        again.message.issuedAt,
      );
    } finally {
      await f.stop();
    }
  },
);

test(
  "a sign-in made before a revocation is refused; a later sign-in authorizes",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19973);
    try {
      const learner = accounts[7];
      f.setOperatorDown(true);
      const s = await f.signIn(learner);
      // The learner withdraws directly on chain after signing in.
      await f.advance(1);
      await f.evm.write(
        f.v4,
        "LearningResultsV4",
        "revoke",
        [learner.address, 0n, "0x"],
        7,
      );
      await f.sync();
      const revokedAt = await f.read<bigint>("revokedAt", [learner.address]);
      assert.ok(revokedAt >= s.message.issuedAt);
      f.setOperatorDown(false);
      await assert.rejects(
        acceptAuthorization(f.operatorEnv, f.store, s.message, s.signature),
        /^Error: revoked_sign_in$/,
      );
      assert.equal(f.count("intent:"), 0);
      assert.equal(f.count("sponsor:reservation:"), 0);
      await f.scheduled();
      assert.deepEqual(await f.authorization(s.id), {
        state: "refused",
        tx_hash: null,
        policy_version: 4,
      });
      assert.equal(await f.read("authorizedSince", [learner.address]), 0n);
      await f.advance(1);
      const after = await f.signIn(learner);
      await f.scheduled();
      assert.equal((await f.authorization(after.id))!.state, "recorded");
      assert.equal(
        await f.read("authorizedSince", [learner.address]),
        after.message.issuedAt,
      );
      const live = (await (
        await (f.env.KARAOKE_OPERATOR as Fetcher).fetch(
          `http://service/authorization/${learner.address}`,
        )
      ).json()) as { since: number; revokedAt: number };
      assert.deepEqual(live, {
        since: Number(after.message.issuedAt),
        revokedAt: Number(revokedAt),
      });
    } finally {
      await f.stop();
    }
  },
);

test(
  "an ERC-8010 sign-in activates the learner's account before it authorizes",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19974);
    try {
      const learner = privateKeyToAccount(generatePrivateKey()),
        passkey = privateKeyToAccount(generatePrivateKey());
      f.operatorEnv.APPROVED_ACTIVATION_ACCOUNT = learner.address;
      const message: SignIn = {
        learner: learner.address,
        communityId: firstSong.directoryProfile.communityId,
        origin: firstSong.origin,
        publicationPolicy: learningV4PublicityPolicy,
        nonce: `0x${"5a".repeat(32)}`,
        issuedAt: BigInt(f.now()),
        expiresAt: BigInt(f.now() + 300),
      };
      const id = signInIdV4(31337, f.v4, message);
      assert.equal(
        hashTypedData({
          domain: {
            name: "Pirate Learning Results",
            version: "4",
            chainId: 31337,
            verifyingContract: f.v4 as Address,
          },
          types: signInTypes,
          primaryType: "SignIn",
          message,
        }),
        id,
      );
      const signature = serializeErc8010Signature({
        authorization: await learner.signAuthorization({
          contractAddress: f.evm.mockAccount,
          chainId: 0,
          nonce: 0,
        }),
        address: f.evm.mockInitializer,
        data: encodeFunctionData({
          abi: parseAbi(["function activate(address account, address key)"]),
          functionName: "activate",
          args: [learner.address, passkey.address],
        }),
        signature: await passkey.sign({ hash: id }),
      });
      let receipt = await acceptAuthorization(
        f.operatorEnv,
        f.store,
        message,
        signature,
      );
      for (let i = 0; i < 3 && receipt.state !== "success"; i++)
        receipt = await acceptAuthorization(
          f.operatorEnv,
          f.store,
          message,
          signature,
        );
      assert.equal(receipt.state, "success");
      assert.deepEqual(
        f.store
          .entries("tx:")
          .map(({ value }) => (value as { kind: string }).kind),
        ["record_activate", "record_authorize"],
      );
      assert.equal(
        String(await f.read("authorizationLearner", [id])).toLowerCase(),
        learner.address.toLowerCase(),
      );
      assert.equal(
        await f.read("authorizedSince", [learner.address]),
        message.issuedAt,
      );
    } finally {
      await f.stop();
    }
  },
);
