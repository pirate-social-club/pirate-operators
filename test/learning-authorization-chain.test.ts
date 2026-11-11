import { currentOperatorAuthorityFixture } from "./learning-current-authority-fixture.ts";
// The V4 sign-in relay on a local chain: the application issues the V4 SIWE
// challenge, a real viem personal-sign signature signs in, and the operator's
// acceptAuthorization records it with LearningResultsV4.authorize. Explicit
// local contracts, fixture keys and journals; no public network or provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  encodeFunctionData,
  hashMessage,
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
  readSignInMessageV4,
  resultsV4Abi,
  signInIdV4,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  acceptAuthorization,
  authorizationRoute,
  AUTHORIZATION_RELAY_WINDOW_S,
  resumeAuthorizations,
} from "../services/learning-authorization.ts";
import {
  practiceAuthorization,
  SIGN_IN_RELAY_WINDOW_S,
} from "../services/learning-sign-in.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";
import {
  scopeOf,
  headKey,
  bootstrapKey,
  type WithdrawalHead,
} from "../services/study-linked-withdrawal-contract.ts";
import { guardLinkedWithdrawal } from "../services/study-linked-withdrawal.ts";

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
    firstSong.origin,
  ]);
  let now = 0;
  // Seconds the application's (and operator's) clock runs ahead of the chain.
  let skew = 0;
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
  const authority = currentOperatorAuthorityFixture({
    now: () => now + skew,
    rpcUrl: evm.rpcUrl,
  });
  await authority.selectV4(communityId, v4);
  const store = authority.store;
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
      if (request.method === "POST")
        relayed.push(`${request.method} ${new URL(request.url).pathname}`);
      if (operatorDown && request.method === "POST")
        throw new Error("fixture operator outage");
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
    KARAOKE_SERVICE_MODE: "internal",
    KARAOKE_PAYMENT_CHAIN_ID: "31337",
    STUDY_RESULTS_V4_CONTRACT: v4,
  } as unknown as CommunityEnv;
  const ports: CommunityDependencies = {
    configuration: async () => config,
    // Through the chain, as the deployed application verifies on MegaETH.
    verifyLogin: verifyLoginOnChain(evm.publicClient),
    creatorHealth: async () => false,
    publicReads: { client: posts.client, profile: posts.profile },
    now: () => (now + skew) * 1000,
  };
  const call = (path: string, init: RequestInit = {}) =>
    communityFetch(new Request(firstSong.origin + path, init), env, ports);
  const post = (
    path: string,
    body: unknown,
    more: Record<string, string> = {},
  ) =>
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
  /** The browser's sign-in: one personal signature over the text as received. */
  async function signIn(account: PrivateKeyAccount) {
    const challenge = (await (
      await post("/api/auth/challenge", { address: account.address })
    ).json()) as SignInChallenge;
    assert.equal(challenge.kind, "sign-in-v4");
    const signature = await account.signMessage({ message: challenge.message });
    const verified = await post("/api/auth/verify", {
      id: challenge.id,
      signature,
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    const message: SignIn = readSignInMessageV4(challenge.message)!.signIn;
    return {
      message,
      signature,
      id: hashMessage(challenge.message),
      auth: { cookie: verified.headers.get("set-cookie")!.split(";")[0]! },
    };
  }
  const authorization = (id: Hex) =>
    runtime.db
      .prepare(
        "SELECT state,tx_hash,policy_version FROM learning_authorizations WHERE authorization_id=?",
      )
      .bind(id)
      .first<{
        state: string;
        tx_hash: string | null;
        policy_version: number;
      }>();
  /** What a Study or Karaoke start does first: choose, or relay, the sign-in. */
  async function practise(s: { message: SignIn }) {
    const { account_id } = (await runtime.db
      .prepare("SELECT account_id FROM credential_bindings WHERE subject=?")
      .bind(s.message.learner.toLowerCase())
      .first<{ account_id: string }>())!;
    return practiceAuthorization(
      env,
      runtime.db,
      account_id,
      s.message.learner,
      now + skew,
      (now + skew) * 1000,
    );
  }
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
    setSkew: (seconds: number) => {
      skew = seconds;
    },
    read,
    post,
    signIn,
    practise,
    authorization,
    session,
    scheduled: async () => {
      await authority.recover();
      await communityScheduled(env, ports);
      await authority.recover();
    },
    count: (prefix: string) => store.entries(prefix).length,
    async stop() {
      authority.close();
      await runtime.dispose();
      await stopChain(evm);
    },
  };
}

test(
  "a V4 sign-in is relayed at the first practice, recorded on chain once, and reported as public results",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19971);
    try {
      const learner = accounts[5];
      const s = await f.signIn(learner);
      // Signing in only stores the sign-in; nothing is relayed or spent.
      assert.deepEqual(f.relayed, []);
      assert.equal((await f.authorization(s.id))!.state, "pending");
      await f.scheduled();
      assert.deepEqual(f.relayed, []);
      assert.equal(f.count("tx:"), 0);
      // The first practice relays it; a scheduled pass settles a late receipt.
      await f.practise(s);
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
      const sent = f.store.entries("tx:").map(
        ({ value }) =>
          value as {
            kind: string;
            ref: string;
            hash: Hex;
            mined: { status: string } | null;
          },
      );
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
        revocationNonce: "0",
      });
      // A later sign-in by the same learner needs no relay, even to practise.
      f.relayed.length = 0;
      await f.advance(5);
      const later = await f.signIn(learner);
      assert.deepEqual(await f.practise(later), { id: s.id });
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
      await f.practise(t);
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
      assert.deepEqual(await f.practise(s), { id: null, pending: true });
      await f.scheduled();
      assert.equal((await f.authorization(s.id))!.state, "pending");
      f.setOperatorDown(false);
      await f.advance(AUTHORIZATION_RELAY_WINDOW_S + 60);
      // The chain refuses it even when the operator's clock lags behind.
      const lagging = new Proxy(f.store, {
        get(target, key) {
          if (key === "now") return () => Number(s.message.issuedAt);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
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
      await f.practise(again);
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
  "a sign-in made before revocation is refused; only explicit turn-on lets a later login authorize",
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
      assert.deepEqual(await f.practise(s), { id: null, pending: false });
      assert.deepEqual(await f.authorization(s.id), {
        state: "refused",
        tx_hash: null,
        policy_version: 4,
      });
      assert.equal(await f.read("authorizedSince", [learner.address]), 0n);
      // A later login notices the chain withdrawal and authenticates only.
      await f.advance(61);
      const challenge = (await (
        await f.post("/api/auth/challenge", { address: learner.address })
      ).json()) as { id: string; message: string; kind?: string };
      assert.equal(challenge.kind, undefined);
      const verified = await f.post("/api/auth/verify", {
        id: challenge.id,
        signature: await learner.signMessage({ message: challenge.message }),
      });
      assert.equal(verified.status, 200);
      const session = (await verified.json()) as { csrf: string };
      assert.equal(await f.read("authorizedSince", [learner.address]), 0n);
      const scope = scopeOf({
        communityId: f.operatorEnv.COMMUNITY_ID,
        learner: learner.address,
        target: { chainId: 31337, version: 4, contract: f.v4 },
      });
      const observe = async (spelling: Address) =>
        await (
          await (f.env.KARAOKE_OPERATOR as Fetcher).fetch(
            `http://service/authorization/${spelling}`,
          )
        ).json();
      // Positive chain withdrawal is still a truthful linked hold until the
      // actual selected source/Store proof and bounded alarm recovery finish.
      assert.deepEqual(
        await observe(learner.address.toLowerCase() as Address),
        {
          since: 0,
          revokedAt: Number(revokedAt),
          revocationNonce: "1",
          linkedWithdrawalPending: true,
        },
      );
      assert.equal(f.count("tx:"), 0);
      assert.equal(f.count("sponsor:reservation:"), 0);
      await f.advance(6);
      await f.scheduled();
      assert.deepEqual(
        await observe(learner.address.toLowerCase() as Address),
        {
          since: 0,
          revokedAt: Number(revokedAt),
          revocationNonce: "1",
        },
      );
      const recoveredHead = f.store.get<WithdrawalHead>(headKey(scope))!;
      assert.equal(recoveredHead.openProofs, 0);
      assert.equal(recoveredHead.sealed, true);
      assert.equal(recoveredHead.cutoffS, Number(revokedAt));
      assert.equal(recoveredHead.nextNonce, "1");
      assert.equal(
        guardLinkedWithdrawal(f.store, scope, Number(s.message.issuedAt)),
        true,
      );
      assert.equal(f.count("tx:"), 0);
      assert.equal(f.count("sponsor:reservation:"), 0);
      // Only an explicit settings action allows the next login to authorize.
      assert.equal(
        (
          await f.post(
            "/api/learning/public-results/on",
            {},
            {
              cookie: verified.headers.get("set-cookie")!.split(";")[0]!,
              "x-csrf-token": session.csrf,
            },
          )
        ).status,
        200,
      );
      await f.advance(2);
      const after = await f.signIn(learner);
      await f.practise(after);
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
        revocationNonce: "1",
      });
      const retainedOperations = f.store.entries("linkedWithdrawalOperation:");
      const retainedHead = f.store.get(headKey(scope));
      const retainedBootstrap = f.store.get(bootstrapKey);
      const sponsorship = f.store.entries("sponsor:");
      for (const spelling of [
        learner.address.toLowerCase() as Address,
        learner.address,
      ]) {
        assert.deepEqual(await observe(spelling), live);
        assert.deepEqual(
          f.store.entries("linkedWithdrawalOperation:"),
          retainedOperations,
        );
        assert.deepEqual(f.store.get(headKey(scope)), retainedHead);
        assert.deepEqual(f.store.get(bootstrapKey), retainedBootstrap);
        assert.deepEqual(f.store.entries("sponsor:"), sponsorship);
      }
      assert.equal(
        guardLinkedWithdrawal(f.store, scope, Number(after.message.issuedAt)),
        false,
      );
      assert.equal(
        guardLinkedWithdrawal(f.store, scope, Number(s.message.issuedAt)),
        true,
      );
      assert.equal(await f.read("revokedAt", [learner.address]), revokedAt);
      assert.equal(await f.read("nextNonce", [learner.address]), 1n);
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
      // No address allowlist: an unrelated new wallet is admitted by caps.
      Object.assign(f.operatorEnv, {
        ACTIVATION_TOTAL_CAP_WEI: "1000000000000000000",
        ACTIVATION_ACCOUNT_CAP_WEI: "40000000000000000",
        ACTIVATION_MAX_ACCOUNTS: "2",
      });
      const message: SignIn = {
        learner: learner.address,
        nonce: `0x${"5a".repeat(32)}`,
        issuedAt: BigInt(f.now()),
      };
      // The account's key signs the EIP-191 hash of the V4 text.
      const id = signInIdV4(
        {
          origin: firstSong.origin,
          chainId: 31337,
          contract: f.v4.toLowerCase() as Address,
          communityId: firstSong.directoryProfile.communityId,
          publicationPolicy: learningV4PublicityPolicy,
        },
        message,
      );
      assert.equal(await f.read("signInDigest", [message]), id);
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

test(
  "an application clock more than the one-minute backdate ahead of the chain keeps the sign-in pending until the chain catches up",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19975);
    try {
      // Within the backdate, a clock ahead of the chain is absorbed.
      f.setSkew(30);
      const absorbed = await f.signIn(accounts[4]);
      assert.equal(Number(absorbed.message.issuedAt), f.now() + 30 - 60);
      f.relayed.length = 0;
      await f.practise(absorbed);
      await f.scheduled();
      assert.equal((await f.authorization(absorbed.id))!.state, "recorded");
      f.setSkew(0);
      await f.sync();
      for (const [index, skew] of [
        [5, 61],
        [6, 62],
      ] as const) {
        const learner = accounts[index];
        // issuedAt is the application's own time less the one-minute backdate.
        f.setSkew(skew);
        const s = await f.signIn(learner);
        assert.equal(Number(s.message.issuedAt), f.now() + skew - 60);
        f.relayed.length = 0;
        // The first practice relays it; the chain cannot accept it yet.
        assert.deepEqual(await f.practise(s), { id: null, pending: true });
        assert.deepEqual(f.relayed, ["POST /authorization"]);
        assert.equal((await f.authorization(s.id))!.state, "pending");
        // The operator's answer is the retryable sign_in_not_yet_valid, with
        // nothing reserved or signed; never the final stale_sign_in.
        await assert.rejects(
          acceptAuthorization(f.operatorEnv, f.store, s.message, s.signature),
          /^Error: sign_in_not_yet_valid$/,
        );
        assert.equal(f.count("intent:record_authorize:"), index - 4);
        assert.equal(
          f.count("sponsor:reservation:record_authorize:"),
          index - 4,
        );
        await f.scheduled();
        assert.equal((await f.authorization(s.id))!.state, "pending");
        assert.equal((await f.session(s.auth)).publicResults, "pending");
        // The chain catches up; the client's retry of the same start records it.
        await f.advance(skew - 60);
        f.setSkew(0);
        await f.practise(s);
        await f.scheduled();
        assert.equal((await f.authorization(s.id))!.state, "recorded");
        assert.deepEqual(await f.practise(s), { id: s.id });
        assert.equal(
          await f.read("authorizedSince", [learner.address]),
          s.message.issuedAt,
        );
        assert.equal((await f.session(s.auth)).publicResults, "on");
      }
    } finally {
      await f.stop();
    }
  },
);

test(
  "six sign-ins without practice send no transaction; with practice an account is relayed at most once",
  { timeout: 120000 },
  async () => {
    const f = await fixture(19976);
    try {
      const learner = accounts[7];
      const rowsOf = async (who: Address) =>
        (
          await f.db
            .prepare(
              "SELECT authorization_id,state,relay_requested_at FROM learning_authorizations WHERE subject=?",
            )
            .bind(who.toLowerCase())
            .all<{
              authorization_id: Hex;
              state: string;
              relay_requested_at: number | null;
            }>()
        ).results;
      const signIns = [];
      for (let i = 0; i < 6; i++) {
        signIns.push(await f.signIn(learner));
        await f.advance(1);
      }
      await f.scheduled();
      await f.scheduled();
      // No relay, transaction or sponsorship, and one pending row: each new
      // sign-in replaced the unrelayed one before it.
      assert.deepEqual(f.relayed, []);
      assert.equal(f.count("tx:"), 0);
      assert.equal(f.count("intent:"), 0);
      assert.equal(f.count("sponsor:reservation:"), 0);
      assert.deepEqual(await rowsOf(learner.address), [
        {
          authorization_id: signIns.at(-1)!.id,
          state: "pending",
          relay_requested_at: null,
        },
      ]);
      // Practice relays the one pending sign-in; later sign-ins and practice
      // never relay again.
      await f.practise(signIns.at(-1)!);
      await f.scheduled();
      for (let i = 0; i < 3; i++) {
        await f.advance(1);
        const again = await f.signIn(learner);
        assert.deepEqual(await f.practise(again), { id: signIns.at(-1)!.id });
        await f.scheduled();
      }
      assert.deepEqual(f.relayed, ["POST /authorization"]);
      assert.equal((await rowsOf(learner.address)).length, 1);
      assert.equal((await rowsOf(learner.address))[0]!.state, "recorded");
      // A second learner practises while the operator is down: their requested
      // relay is the account's only pending row, and a new sign-in adds none.
      const other = accounts[8];
      f.setOperatorDown(true);
      const first = await f.signIn(other);
      assert.deepEqual(await f.practise(first), { id: null, pending: true });
      await f.advance(1);
      const second = await f.signIn(other);
      assert.deepEqual(
        (await rowsOf(other.address)).map((r) => r.authorization_id),
        [first.id],
      );
      f.setOperatorDown(false);
      assert.deepEqual(await f.practise(second), { id: first.id });
      await f.scheduled();
      assert.equal(f.count("intent:record_authorize:"), 2);
      assert.equal(f.count("sponsor:reservation:record_authorize:"), 2);
      assert.equal(f.count("tx:"), 2);
    } finally {
      await f.stop();
    }
  },
);

test(
  "second-community preflight reads actual V4 context and separate grader permissions",
  { timeout: 120000 },
  async () => {
    const { communityAuthorityReader, verifyCommunityAuthority } = await import(
      "../packages/community-setup/authority.ts"
    );
    const f = await fixture(19977);
    try {
      const settings = {
        chainId: 31337 as const,
        resultsContract: f.v4.toLowerCase(),
        communityId: firstSong.directoryProfile.communityId,
        origin: firstSong.origin,
        owner: accounts[3].address.toLowerCase(),
        grader: accounts[2].address.toLowerCase(),
      };
      const probe = async () =>
        verifyCommunityAuthority(
          settings,
          learningV4PublicityPolicy,
          await communityAuthorityReader(f.evm.rpcUrl),
        );
      await assert.rejects(probe(), /setup_grader_permission_missing/);
      for (const activity of [1, 2])
        await f.evm.write(
          f.v4,
          "LearningResultsV4",
          "setGrader",
          [accounts[2].address, activity, true],
          3,
        );
      assert.equal((await probe()).communityId, settings.communityId);
      await assert.rejects(
        verifyCommunityAuthority(
          { ...settings, communityId: `0x${"ff".repeat(32)}` },
          learningV4PublicityPolicy,
          await communityAuthorityReader(f.evm.rpcUrl),
        ),
        /setup_contract_context_mismatch/,
      );
    } finally {
      await f.stop();
    }
  },
);
