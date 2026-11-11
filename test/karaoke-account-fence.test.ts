import { enrollStudyForAccount } from "../apps/web/src/study/enrollment-intent.ts";
// Real same-origin routes, D1 sessions and offline SIWE verification.
// The operator list response is an explicit service-binding simulation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { communityRuntime } from "./community-runtime.ts";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import {
  communityFetch,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";

// Public fixture keys. No network, chain transaction or funded operation.
const learner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
async function fixture(enrollment = false) {
  const runtime = await communityRuntime();
  const deployment = JSON.parse(
    await readFile(
      new URL(
        "../docs/deployments/first-song-managed-20261105.configuration.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const config = validateConfig({
    ...deployment.configuration,
    publisher: publisher.address.toLowerCase(),
  });
  const posts = releasePostsFixture(publisher, config);
  const dispatched: Array<{ path: string; body: unknown }> = [];
  const env = {
    DB: runtime.db,
    MEDIA: runtime.media,
    JOBS: { send: async () => {} },
    ASSETS: { fetch: async () => new Response("fixture") },
    COMMUNITY_NAME: firstSong.name,
    PLAN_ID: firstSong.planId,
    APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
    CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
    KARAOKE_SERVICE_MODE: "internal",
    KARAOKE_OPERATOR: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        dispatched.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        if (
          enrollment &&
          new URL(request.url).pathname === "/enrollment/request"
        ) {
          const contract = learner.address,
            policy = `0x${"a".repeat(64)}`;
          return Response.json({
            target: { version: 3, chainId: 6343, contract },
            domain: {
              version: "3",
              chainId: 6343,
              verifyingContract: contract,
            },
            types: {},
            primaryType: "Enrollment",
            message: {
              learner: learner.address.toLowerCase(),
              activities: "2",
              publicityPolicy: policy,
            },
            disclosure: {
              version: 3,
              termsUrl: "/learning/v3/terms",
              privacyUrl: "/learning/v3/privacy",
              publicityPolicy: policy,
            },
          });
        }
        if (enrollment && new URL(request.url).pathname === "/enrollment")
          return Response.json({ state: "success" });
        assert.equal(new URL(request.url).pathname, "/enrollment/list");
        return Response.json({ enrollments: [] });
      },
    },
    KARAOKE_OPERATOR_ADDRESS: publisher.address,
    KARAOKE_OPERATOR_ORIGIN: "https://operator.example",
    KARAOKE_SIGNER_PRIVATE_KEY: `0x${"13".repeat(32)}`,
    KARAOKE_COMMUNITY_ADDRESS: learner.address,
    KARAOKE_PAYMENT_CHAIN_ID: "6343",
    KARAOKE_PAYMENT_TOKEN: publisher.address,
    KARAOKE_RPC_URL: "https://unused-rpc.invalid",
  } as unknown as CommunityEnv;
  const ports: CommunityDependencies = {
    configuration: async () => config,
    publicReads: { client: posts.client, profile: posts.profile },
    verifyLogin: verifyLoginOffline,
    creatorHealth: async () => false,
  };
  const call = (path: string, init: RequestInit = {}) =>
    communityFetch(new Request(firstSong.origin + path, init), env, ports);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    call(path, {
      method: "POST",
      headers: {
        origin: firstSong.origin,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    const challenge = (await (
      await post("/api/auth/challenge", { address: learner.address })
    ).json()) as { id: string; message: string };
    const verified = await post("/api/auth/verify", {
      id: challenge.id,
      signature: await learner.signMessage({ message: challenge.message }),
    });
    assert.equal(verified.status, 200);
    const body = (await verified.json()) as { csrf: string };
    const auth = {
      cookie: verified.headers.get("set-cookie")!.split(";")[0]!,
      "x-csrf-token": body.csrf,
    };
    return { ...runtime, call, post, auth, dispatched };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("private Karaoke JSON rejects missing/wrong expected account before proof exposure or operator work", async () => {
  const f = await fixture();
  try {
    for (const expected of [null, "0x" + "22".repeat(20)]) {
      const headers = {
        ...f.auth,
        ...(expected ? { "x-study-account": expected } : {}),
      };
      const response = await f.call(
        "/api/karaoke/attempt?postId=0x" + "aa".repeat(32),
        { headers },
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "study_account_changed",
      });
      for (const path of [
        "history",
        "enrollments",
        "enrollment/revoke",
        "enrollment",
        "tickets",
        "purchases",
        "consent",
      ]) {
        const response = await f.post("/api/karaoke/" + path, {}, headers);
        assert.equal(response.status, 409, path);
        assert.deepEqual(await response.json(), {
          error: "study_account_changed",
        });
      }
    }
    assert.deepEqual(f.dispatched, []);
    assert.equal(
      await f.db.prepare("SELECT COUNT(*) AS n FROM karaoke_state").first("n"),
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("matching expected account reaches the actual private handler, but cannot replace cookie, CSRF or Origin authority", async () => {
  const f = await fixture();
  try {
    const expected = { "x-study-account": learner.address };
    const response = await f.post(
      "/api/karaoke/enrollments",
      {},
      { ...f.auth, ...expected },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enrollments: [] });
    assert.deepEqual(f.dispatched, [
      {
        path: "/enrollment/list",
        body: { learner: learner.address.toLowerCase() },
      },
    ]);
    assert.equal(
      (await f.post("/api/karaoke/enrollments", {}, expected)).status,
      401,
    );
    assert.equal(
      (
        await f.post(
          "/api/karaoke/enrollments",
          {},
          { cookie: f.auth.cookie, ...expected },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.post(
          "/api/karaoke/enrollments",
          {},
          { ...f.auth, ...expected, origin: "https://other.example" },
        )
      ).status,
      403,
    );
    assert.equal(f.dispatched.length, 1);
    // Sign-out remains an authenticated same-origin action without this page fence.
    assert.equal((await f.post("/api/logout", {}, f.auth)).status, 200);
  } finally {
    await f.dispose();
  }
});

// Proposed additions to test/karaoke-account-fence.test.ts, after the exact
// fixture amendments in actual-enrollment-handler-regressions.patch. UNRUN.
test("legacy Study enrollment helper sends the same captured account on both real fenced requests", async () => {
  const f = await fixture(true),
    savedFetch = globalThis.fetch;
  const sent: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(new URL(String(input), firstSong.origin), init);
    assert.equal(request.credentials, "same-origin");
    assert.equal(request.headers.get("x-study-account"), learner.address);
    assert.equal(request.headers.get("x-csrf-token"), f.auth["x-csrf-token"]);
    const headers = new Headers(request.headers);
    headers.set("cookie", f.auth.cookie);
    headers.set("origin", firstSong.origin); // Browser's same-origin write behavior.
    const forwarded = new Request(request, { headers });
    sent.push(forwarded.clone());
    return f.call(new URL(forwarded.url).pathname, {
      method: forwarded.method,
      headers,
      body: await forwarded.text(),
    });
  }) as typeof fetch;
  try {
    await enrollStudyForAccount({
      account: () => learner.address,
      csrf: () => f.auth["x-csrf-token"],
      active: () => true,
      wallet: {
        signConsent: async (request) => {
          assert.equal(
            String(request.message.learner).toLowerCase(),
            learner.address.toLowerCase(),
          );
          return "fixture-signature"; // Operator signature verification is explicitly simulated.
        },
      },
    });
    assert.equal(sent.length, 2);
    assert.deepEqual(
      f.dispatched.map((item) => item.path),
      ["/enrollment/request", "/enrollment"],
    );
    assert.deepEqual(await sent[0]!.json(), { activity: "study" });
    const submitted = (await sent[1]!.json()) as {
      signature: string;
      enrollment: { learner: string };
    };
    assert.equal(submitted.signature, "fixture-signature");
    assert.equal(submitted.enrollment.learner, learner.address.toLowerCase());
  } finally {
    globalThis.fetch = savedFetch;
    await f.dispose();
  }
});

test("the second enrollment call cannot bypass the real account fence by retaining only cookie and CSRF", async () => {
  const f = await fixture(true),
    savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(new URL(String(input), firstSong.origin), init),
      headers = new Headers(request.headers);
    calls++;
    if (calls === 2) headers.delete("x-study-account");
    headers.set("cookie", f.auth.cookie);
    headers.set("origin", firstSong.origin);
    return f.call(new URL(request.url).pathname, {
      method: request.method,
      headers,
      body: await request.text(),
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      enrollStudyForAccount({
        account: () => learner.address,
        csrf: () => f.auth["x-csrf-token"],
        active: () => true,
        wallet: { signConsent: async () => "fixture-signature" },
      }),
      { code: "study_account_changed" },
    );
    assert.equal(calls, 2);
    assert.deepEqual(
      f.dispatched.map((item) => item.path),
      ["/enrollment/request"],
    );
  } finally {
    globalThis.fetch = savedFetch;
    await f.dispose();
  }
});

test("ticket pre-handler refusals preserve cookie/CSRF/Origin authority and never reach reservation work", async () => {
  const f = await fixture();
  try {
    const expected = { "x-study-account": learner.address };
    for (const [headers, status, code] of [
      [expected, 401, "session_required"],
      [{ cookie: f.auth.cookie, ...expected }, 403, "csrf_required"],
      [
        { ...f.auth, ...expected, origin: "https://other.example" },
        403,
        "wrong_origin",
      ],
    ] as const) {
      const response = await f.post(
        "/api/karaoke/tickets",
        { postId: "0x" + "aa".repeat(32) },
        headers,
      );
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    }
    assert.deepEqual(f.dispatched, []);
    assert.equal(
      await f.db.prepare("SELECT COUNT(*) AS n FROM karaoke_state").first("n"),
      0,
    );
  } finally {
    await f.dispose();
  }
});
