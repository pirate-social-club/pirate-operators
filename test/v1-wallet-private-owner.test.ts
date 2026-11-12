// UNRUN. Real local accounts cryptography/D1 and actual rewards producer. No remote/provider/funds.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  loginChallenge,
  loginVerify,
  accountSession,
} from "../packages/community/accounts.ts";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { rewardsCommunityApi } from "../services/rewards-community-api.ts";
import { CommunityError } from "../packages/community/common.ts";
import {
  manualRewardsFixture,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";

test("actual private rewards envelopes use login-produced UUIDs and reject replacement-session read guards", async () => {
  const f = await manualRewardsFixture();
  try {
    const context = {
      communityId: ("0x" + "77".repeat(32)) as `0x${string}`,
      origin: "https://private-rewards.example",
    };
    async function session() {
      // Ephemeral disposable local signer only, created when coordinator runs this test.
      const signer = privateKeyToAccount(generatePrivateKey());
      const challenge = await loginChallenge(f.db, context, signer.address);
      const signature = await signer.signMessage({
        message: challenge.message,
      });
      const result = await loginVerify(
        f.db,
        context,
        challenge.id,
        signature,
        verifyLoginOffline,
      );
      const cookie = result.cookie.split(";")[0];
      const current = await accountSession(
        new Request(context.origin + "/api/session", { headers: { cookie } }),
        f.db,
        context,
      );
      assert.match(current.account_id, /^[0-9a-f-]{36}$/);
      assert.notEqual(current.account_id, current.author_id);
      assert.notEqual(current.account_id, current.wallet);
      return { cookie, current };
    }
    const a = await session(),
      b = await session();
    Object.assign(f.principals[0], {
      accountId: a.current.account_id,
      wallet: a.current.wallet,
    });
    Object.assign(f.principals[1], {
      accountId: b.current.account_id,
      wallet: b.current.wallet,
    });
    await f.settle("offer_0001", "1");
    await f.settle("offer_0002", "2");
    let balances = 0;
    const ports = {
      db: f.db,
      profile: rewardTestProfile,
      now: f.now,
      chain: {
        ...f.chain,
        balance: async (...args: Parameters<typeof f.chain.balance>) => {
          balances++;
          return f.chain.balance(...args);
        },
      },
      verification: f.provider,
    };
    async function call(
      cookie: string,
      path: string,
      owner: string,
      csrf: string,
    ) {
      return rewardsCommunityApi(
        new Request(context.origin + path, {
          headers: {
            cookie,
            "x-csrf-token": csrf,
            "x-pirate-reward-owner": owner,
          },
        }),
        ports,
        context,
        new Headers(),
      );
    }
    const wallet = (await (await call(
      a.cookie,
      "/api/rewards/wallet",
      a.current.account_id,
      a.current.csrf_token,
    ))!.json()) as { accountId: string; address: string };
    assert.equal(wallet.accountId, a.current.account_id);
    assert.equal(wallet.address, a.current.wallet);
    const page = (await (await call(
      a.cookie,
      "/api/rewards/credits?limit=1",
      a.current.account_id,
      a.current.csrf_token,
    ))!.json()) as {
      accountId: string;
      items: { credit_id: string; account_id: string }[];
      next_cursor: string;
    };
    assert.equal(page.accountId, a.current.account_id);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].account_id, a.current.account_id);
    const nextPath =
      "/api/rewards/credits?limit=1&cursor=" +
      encodeURIComponent(page.next_cursor);
    const second = (await (await call(
      a.cookie,
      nextPath,
      a.current.account_id,
      a.current.csrf_token,
    ))!.json()) as typeof page;
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].account_id, a.current.account_id);
    assert.notEqual(second.items[0].credit_id, page.items[0].credit_id);
    const before = balances;
    for (const path of ["/api/rewards/wallet", nextPath]) {
      await assert.rejects(
        call(b.cookie, path, a.current.account_id, a.current.csrf_token),
        (error: unknown) =>
          error instanceof CommunityError &&
          error.status === 403 &&
          error.code === "reward_session_changed",
      );
      await assert.rejects(
        call(a.cookie, path, b.current.account_id, a.current.csrf_token),
        (error: unknown) =>
          error instanceof CommunityError && error.status === 403,
      );
    }
    assert.equal(balances, before); // mismatch refused before private chain/credit reads
    const current = (await (await call(
      b.cookie,
      "/api/rewards/credits",
      b.current.account_id,
      b.current.csrf_token,
    ))!.json()) as {
      accountId: string;
      items: { credit_id: string; account_id: string; token_address: string }[];
    };
    assert.equal(current.accountId, b.current.account_id);
    assert.equal(current.items.length, 2);
    assert.ok(
      current.items.every(
        (row) =>
          row.account_id === b.current.account_id &&
          row.token_address === rewardTestProfile.token,
      ),
    );
    assert.ok(
      current.items.every(
        (row) =>
          row.credit_id !== page.items[0].credit_id &&
          row.credit_id !== second.items[0].credit_id,
      ),
    );
  } finally {
    await f.dispose();
  }
});

test("actual same-account renewed login retains its private UUID but requires the renewed session CSRF", async () => {
  const f = await manualRewardsFixture();
  try {
    const context = {
      communityId: ("0x" + "78".repeat(32)) as `0x${string}`,
      origin: "https://renewed-rewards.example",
    };
    // Future coordinator-run disposable local fixture only; no export or funding.
    const signer = privateKeyToAccount(generatePrivateKey());
    async function login() {
      const challenge = await loginChallenge(f.db, context, signer.address);
      const signature = await signer.signMessage({
        message: challenge.message,
      });
      const result = await loginVerify(
        f.db,
        context,
        challenge.id,
        signature,
        verifyLoginOffline,
      );
      const cookie = result.cookie.split(";")[0];
      const current = await accountSession(
        new Request(context.origin + "/api/session", { headers: { cookie } }),
        f.db,
        context,
      );
      assert.equal(current.csrf_token, result.csrf);
      return { cookie, current };
    }
    const original = await login();
    Object.assign(f.principals[0], {
      accountId: original.current.account_id,
      wallet: original.current.wallet,
    });
    await f.settle("offer_0001", "1");
    await f.settle("offer_0002", "2");
    let balances = 0;
    const ports = {
      db: f.db,
      profile: rewardTestProfile,
      now: f.now,
      verification: f.provider,
      chain: {
        ...f.chain,
        balance: async (...args: Parameters<typeof f.chain.balance>) => {
          balances++;
          return f.chain.balance(...args);
        },
      },
    };
    async function read(cookie: string, path: string, csrf: string) {
      return rewardsCommunityApi(
        new Request(context.origin + path, {
          headers: {
            cookie,
            "x-csrf-token": csrf,
            "x-pirate-reward-owner": original.current.account_id,
          },
        }),
        ports,
        context,
        new Headers(),
      );
    }
    type Page = {
      accountId: string;
      items: { credit_id: string; account_id: string }[];
      next_cursor: string | null;
    };
    const first = (await (await read(
      original.cookie,
      "/api/rewards/credits?limit=1",
      original.current.csrf_token,
    ))!.json()) as Page;
    assert.equal(first.accountId, original.current.account_id);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].account_id, original.current.account_id);
    assert.ok(first.next_cursor);
    const nextPath =
      "/api/rewards/credits?limit=1&cursor=" +
      encodeURIComponent(first.next_cursor);
    const renewed = await login();
    assert.equal(renewed.current.account_id, original.current.account_id);
    assert.equal(renewed.current.author_id, original.current.author_id);
    assert.equal(renewed.current.wallet, original.current.wallet);
    assert.notEqual(renewed.current.csrf_token, original.current.csrf_token);
    assert.notEqual(
      renewed.current.session_hash,
      original.current.session_hash,
    );
    const before = balances,
      providerOpenings = f.openings();
    for (const path of ["/api/rewards/wallet", nextPath]) {
      await assert.rejects(
        read(renewed.cookie, path, original.current.csrf_token),
        (error: unknown) =>
          error instanceof CommunityError &&
          error.status === 403 &&
          error.code === "reward_session_changed",
      );
    }
    assert.equal(balances, before);
    assert.equal(f.openings(), providerOpenings);
    const current = (await (await read(
      renewed.cookie,
      nextPath,
      renewed.current.csrf_token,
    ))!.json()) as Page;
    assert.equal(current.accountId, original.current.account_id);
    assert.equal(current.items.length, 1);
    assert.equal(current.items[0].account_id, original.current.account_id);
    assert.notEqual(current.items[0].credit_id, first.items[0].credit_id);
    // Renewing a login does not revoke another still-valid session of that owner.
    const originalStillValid = (await (await read(
      original.cookie,
      nextPath,
      original.current.csrf_token,
    ))!.json()) as Page;
    assert.deepEqual(originalStillValid.items, current.items);
    await assert.rejects(
      rewardsCommunityApi(
        new Request(
          context.origin +
            `/api/rewards/credits/${first.items[0].credit_id}/claim`,
          {
            method: "POST",
            headers: {
              cookie: renewed.cookie,
              origin: context.origin,
              "content-type": "application/json",
              "x-csrf-token": original.current.csrf_token,
            },
            body: "{}",
          },
        ),
        ports,
        context,
        new Headers(),
      ),
      (error: unknown) =>
        error instanceof CommunityError &&
        error.status === 403 &&
        error.code === "csrf_required",
    );
    assert.equal(f.openings(), providerOpenings);
  } finally {
    await f.dispose();
  }
});
