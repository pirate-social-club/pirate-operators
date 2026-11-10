// Real local D1; the explicitly simulated operator supplies authority facts.
import test from "node:test";
import assert from "node:assert/strict";
import { communityRuntime } from "./community-runtime.ts";
import {
  practiceAuthorization,
  liveAccountAuthorization,
} from "../services/learning-sign-in.ts";
import { publicationSignInAtLogin } from "../services/learning-public-results.ts";
import { accounts } from "../harness/runtime.ts";
import type { SignInV4 } from "../packages/community/accounts.ts";
const subject = accounts[5].address.toLowerCase();
const id = `0x${"ab".repeat(32)}` as const;
const live = { since: 100, revokedAt: 0, revocationNonce: "0" };
const operator = (fetch: () => Promise<Response>) => ({
  KARAOKE_OPERATOR: {
    fetch,
    connect() {
      throw Error("fixture socket unused");
    },
  } satisfies Fetcher,
});
async function fixture() {
  const f = await communityRuntime({ v4: true });
  await f.db
    .prepare(
      "INSERT INTO application_identity(id,community_id,community_origin) VALUES(1,?,'https://community.example')",
    )
    .bind(id)
    .run();
  await f.db
    .prepare(
      "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES('a','author-a',0)",
    )
    .run();
  await f.db
    .prepare(
      `INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at)
    VALUES('b','a','moss',6343,?,0)`,
    )
    .bind(subject)
    .run();
  await f.db
    .prepare(
      `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
    VALUES(?,'a',?,'{}','','0x',?,4,100,'recorded',0,0)`,
    )
    .bind(id, subject, id)
    .run();
  return f;
}
test("practice refuses revoked or restarted authority, unrelated account and uncertain reads", async () => {
  const f = await fixture();
  try {
    const admission = (value: unknown, account = "a") =>
      practiceAuthorization(
        operator(async () => Response.json(value)),
        f.db,
        account,
        subject,
        110,
        110000,
      );
    assert.deepEqual(await admission(live), { id });
    assert.deepEqual(
      await admission({
        ...live,
        since: 0,
        revokedAt: 105,
        revocationNonce: "1",
      }),
      { id: null, pending: false },
    );
    assert.deepEqual(
      await admission({
        ...live,
        since: 106,
        revokedAt: 105,
        revocationNonce: "1",
      }),
      { id: null, pending: false },
    );
    assert.deepEqual(await admission({ ...live, pendingWithdrawal: true }), {
      id: null,
      pending: false,
    });
    assert.deepEqual(await admission({ ...live, revocationNonce: "01" }), {
      id: null,
      pending: true,
    });
    assert.deepEqual(await admission(live, "other"), {
      id: null,
      pending: false,
    });
    assert.deepEqual(
      await practiceAuthorization(
        operator(async () => {
          throw Error("outage");
        }),
        f.db,
        "a",
        subject,
        110,
        110000,
      ),
      { id: null, pending: true },
    );
    assert.equal(
      await liveAccountAuthorization(
        operator(async () => new Promise(() => {})),
        subject,
        5,
      ),
      undefined,
    );
  } finally {
    await f.dispose();
  }
});
test("withdrawal during a slow authority read fences both practice and login", async () => {
  const f = await fixture();
  try {
    const slow = operator(async () => {
      await f.db
        .prepare(
          "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES('a',105000,105000) ON CONFLICT DO NOTHING",
        )
        .run();
      return Response.json(live); // stale response from before the withdrawal
    });
    assert.deepEqual(
      await practiceAuthorization(slow, f.db, "a", subject, 110, 110000),
      { id: null, pending: false },
    );
    await f.db.prepare("DELETE FROM learning_settings").run();
    const v4: SignInV4 = {
      chainId: 6343,
      contract: accounts[0].address,
      communityId: id,
      publicationPolicy: id,
      policyVersion: 4,
    };
    assert.equal(
      await publicationSignInAtLogin(slow, f.db, subject, v4),
      undefined,
    );
  } finally {
    await f.dispose();
  }
});

test("unlink during live admission refuses connected learning without importing trial history", async () => {
  const { connectedPracticeAuthorization } = await import(
    "../services/learning-sign-in.ts"
  );
  const f = await fixture();
  try {
    const context = {
      communityId: id,
      botId: "123",
      generation: 1,
      startedAtMs: 110000,
    };
    const link = {
      version: 1 as const,
      communityId: id,
      botId: "123",
      generation: 1,
      accountId: "a",
      wallet: subject,
      linkedAtMs: 110000,
      revokedAtMs: null,
    };
    let resolves = 0;
    await assert.rejects(
      connectedPracticeAuthorization(
        operator(async () => Response.json(live)),
        f.db,
        context,
        async () => (++resolves === 1 ? link : null),
      ),
      /connected_learning_link_required/,
    );
    assert.deepEqual(
      await connectedPracticeAuthorization(
        operator(async () => Response.json(live)),
        f.db,
        context,
        async () => link,
      ),
      { id },
    );
    await assert.rejects(
      connectedPracticeAuthorization(
        operator(async () => Response.json(live)),
        f.db,
        { ...context, startedAtMs: 109999 },
        async () => link,
      ),
      /not_prospective/,
    );
  } finally {
    await f.dispose();
  }
});
