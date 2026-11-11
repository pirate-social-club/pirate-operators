// UNRUN successor proposal. Actual communityFetch cookie/logout/D1/CAS and
// operator SQLite/crypto routes from the preserved read fixture. Contract reads
// are explicit ABI fixtures; no browser, provider, native or public-chain claim.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyMessage } from "viem";
import { accounts } from "../harness/runtime.ts";
import { hashText } from "../packages/community/common.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  digest,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import { karaokeAttempt } from "../services/karaoke-community.ts";
import { KaraokeRequestSession } from "../services/karaoke-request-session.ts";
import { createOperatorKaraokePort } from "../apps/web/src/karaoke/operator-karaoke-adapter.ts";
import { readRecoveryFixture } from "./karaoke-reservation-read-fixture.ts";

type Fixture = Awaited<ReturnType<typeof readRecoveryFixture>>;
type SessionRow = {
  session_hash: string;
  community_id: string;
  community_origin: string;
  account_id: string;
  binding_id: string;
  csrf_token: string;
  expires_at: number;
};
const sessionHash = (f: Fixture) => hashText(f.auth.cookie.split("=")[1]);
const sessionRow = (f: Fixture) =>
  f.db
    .prepare("SELECT * FROM community_sessions WHERE session_hash=?")
    .bind(sessionHash(f))
    .first<SessionRow>();
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function original(f: Fixture, stage: "missing" | "interrupted") {
  f.fault(stage === "missing" ? "cas" : "prepareAck");
  const response = await f.create();
  assert.notEqual(response.status, 200);
  const rejected = await response.json();
  assert.ok(rejected !== null && typeof rejected === "object");
  assert.equal(Object.hasOwn(rejected, "proof"), false);
  const state = await f.walletState();
  assert.ok(state.open?.recoveryScope);
  assert.equal(f.counts.ticketPosts, 1);
  assert.equal(state.sequence, 1);
  if (stage === "missing")
    assert.equal(await f.row(`ticket:${state.open.ticketId}`), undefined);
  else assert.ok(await f.row(`ticket:${state.open.ticketId}`));
  return state;
}
function holdPrepare(f: Fixture, mode: "ack" | "body") {
  const entered = deferred(),
    release = deferred();
  if (mode === "ack")
    f.afterPrepare(async () => {
      entered.resolve();
      await release.promise;
    });
  else {
    const delegate = f.env.KARAOKE_OPERATOR!;
    f.env.KARAOKE_OPERATOR = {
      ...delegate,
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
        ).pathname;
        const response = await delegate.fetch(input, init);
        if (path !== "/prepare" || !response.ok) return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            entered.resolve();
            void release.promise.then(() => {
              controller.enqueue(bytes);
              controller.close();
            });
          },
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    } as Fetcher;
  }
  return { entered: entered.promise, release: release.resolve };
}
async function actualLogout(f: Fixture) {
  const response = await f.post("/api/logout", {}, f.auth);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { signedOut: true });
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(await sessionRow(f), null);
  // Logout is the real session producer's deletion, not chain withdrawal.
  assert.deepEqual(f.store.entries("revocationIntent:"), []);
  assert.ok(
    await f.db
      .prepare(
        "SELECT authorization_id FROM learning_authorizations WHERE account_id='a' AND state='recorded'",
      )
      .first(),
  );
}
async function denied(response: Response) {
  assert.equal(response.status, 409);
  const value = await response.json();
  assert.deepEqual(value, { error: "karaoke_session_changed" });
  assert.equal(Object.hasOwn(value, "proof"), false);
  assert.equal(Object.hasOwn(value, "ticket"), false);
}
async function unchanged(
  f: Fixture,
  state: Awaited<ReturnType<Fixture["walletState"]>>,
  ticketHash: string,
  sponsorHash: string,
) {
  assert.ok(state.open);
  assert.deepEqual(await f.walletState(), state);
  assert.equal(f.counts.ticketPosts, 1);
  assert.equal(f.counts.casCommits, 1);
  assert.equal(
    digest(await f.row(`ticket:${state.open.ticketId}`)),
    ticketHash,
  );
  assert.equal(
    digest(f.store.get(`ticket:${state.open.ticketId}`)),
    ticketHash,
  );
  assert.equal(digest(f.store.entries("sponsor:")), sponsorHash);
}

for (const stage of ["missing", "interrupted"] as const)
  for (const mode of ["ack", "body"] as const)
    test(`canonical GET ${stage}/${mode}: real logout after prepared commit denies late proof without another create`, async () => {
      const f = await readRecoveryFixture();
      let gate: ReturnType<typeof holdPrepare> | undefined,
        pending: Promise<Response> | undefined;
      try {
        const state = await original(f, stage);
        assert.ok(state.open);
        gate = holdPrepare(f, mode);
        pending = f.get();
        await gate.entered;
        const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`));
        const sponsorHash = digest(f.store.entries("sponsor:"));
        const ack = digest(
          f.store.get(`karaokePreparedV1:${state.open.ticketId}`),
        );
        await actualLogout(f);
        gate.release();
        await denied(await pending);
        await unchanged(f, state, ticketHash, sponsorHash);
        assert.equal(
          digest(f.store.get(`karaokePreparedV1:${state.open.ticketId}`)),
          ack,
        );
        assert.equal((await f.get()).status, 401); // no current cookie, no new operator work
        assert.equal(f.counts.ticketPosts, 1);
      } finally {
        gate?.release();
        await pending?.catch(() => undefined);
        await f.dispose();
      }
    });

for (const mode of ["ack", "body"] as const)
  test(`canonical GET ${mode}: original cookie expiry at exact live boundary denies late proof`, async (t) => {
    const f = await readRecoveryFixture();
    let gate: ReturnType<typeof holdPrepare> | undefined,
      pending: Promise<Response> | undefined;
    let wall = Date.now();
    t.mock.method(Date, "now", () => wall);
    try {
      const state = await original(f, "interrupted");
      assert.ok(state.open);
      const current = await sessionRow(f);
      assert.ok(current);
      // Fixture-only short TTL is set BEFORE this request captures its session.
      // Advance only one second, without wall-clock waiting or a month jump.
      const session = { ...current, expires_at: wall + 1000 };
      await f.db
        .prepare(
          "UPDATE community_sessions SET expires_at=? WHERE session_hash=?",
        )
        .bind(session.expires_at, session.session_hash)
        .run();
      gate = holdPrepare(f, mode);
      pending = f.get();
      await gate.entered;
      const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`));
      const sponsorHash = digest(f.store.entries("sponsor:"));
      wall = session.expires_at; // exact equality; chain and ticket clocks remain valid
      gate.release();
      await denied(await pending);
      assert.deepEqual(await sessionRow(f), session); // expiry, not a fake logout flag
      await unchanged(f, state, ticketHash, sponsorHash);
    } finally {
      gate?.release();
      await pending?.catch(() => undefined);
      await f.dispose();
    }
  });

for (const mutation of [
  "replacement",
  "expiryExtension",
  "csrf",
  "privateAccount",
  "wallet",
  "binding",
  "community",
] as const)
  test(`held canonical body refuses same-cookie ${mutation} row/binding change`, async () => {
    const f = await readRecoveryFixture();
    let gate: ReturnType<typeof holdPrepare> | undefined,
      pending: Promise<Response> | undefined;
    try {
      const state = await original(f, "interrupted");
      assert.ok(state.open);
      const captured = await sessionRow(f);
      assert.ok(captured);
      gate = holdPrepare(f, "body");
      pending = f.get();
      await gate.entered;
      const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`)),
        sponsorHash = digest(f.store.entries("sponsor:"));
      if (mutation === "replacement") {
        // Fault-inject actual D1 replacement: same cookie hash/account/wallet,
        // new CSRF/expiry. No production producer legitimately reuses a cookie.
        await f.db
          .prepare("DELETE FROM community_sessions WHERE session_hash=?")
          .bind(captured.session_hash)
          .run();
        await f.db
          .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
          .bind(
            captured.session_hash,
            captured.community_id,
            captured.community_origin,
            captured.account_id,
            captured.binding_id,
            "replacement-csrf",
            captured.expires_at + 1000,
          )
          .run();
      }
      if (mutation === "expiryExtension")
        await f.db
          .prepare(
            "UPDATE community_sessions SET expires_at=? WHERE session_hash=?",
          )
          .bind(captured.expires_at + 1000, captured.session_hash)
          .run();
      if (mutation === "csrf")
        await f.db
          .prepare(
            "UPDATE community_sessions SET csrf_token='replacement-csrf' WHERE session_hash=?",
          )
          .bind(captured.session_hash)
          .run();
      if (mutation === "privateAccount") {
        await f.db
          .prepare(
            "UPDATE credential_bindings SET account_id='b' WHERE binding_id=?",
          )
          .bind(captured.binding_id)
          .run();
        await f.db
          .prepare(
            "UPDATE community_sessions SET account_id='b' WHERE session_hash=?",
          )
          .bind(captured.session_hash)
          .run();
      }
      if (mutation === "wallet")
        await f.db
          .prepare(
            "UPDATE credential_bindings SET subject=? WHERE binding_id=?",
          )
          .bind(accounts[6].address.toLowerCase(), captured.binding_id)
          .run();
      if (mutation === "binding") {
        await f.db
          .prepare(
            "INSERT INTO credential_bindings VALUES('replacement-binding','a','fixture',6343,?,0)",
          )
          .bind(f.wallet)
          .run();
        await f.db
          .prepare(
            "UPDATE community_sessions SET binding_id='replacement-binding' WHERE session_hash=?",
          )
          .bind(captured.session_hash)
          .run();
      }
      if (mutation === "community")
        await f.db
          .prepare(
            "UPDATE community_sessions SET community_origin='https://other.invalid' WHERE session_hash=?",
          )
          .bind(captured.session_hash)
          .run();
      gate.release();
      await denied(await pending);
      await unchanged(f, state, ticketHash, sponsorHash);
    } finally {
      gate?.release();
      await pending?.catch(() => undefined);
      await f.dispose();
    }
  });

for (const mode of ["ack", "body"] as const)
  test(`late ticket POST ${mode} session loss remains unknown and cannot automatically repeat create`, async () => {
    const f = await readRecoveryFixture();
    const port = createOperatorKaraokePort({
      account: f.wallet,
      postId: f.postId,
      csrf: () => f.auth["x-csrf-token"],
    });
    const gate = holdPrepare(f, mode);
    let pending: ReturnType<typeof port.ticket> | undefined;
    try {
      pending = port.ticket();
      const rejected = assert.rejects(pending, /confirm this take/);
      await gate.entered;
      const state = await f.walletState();
      assert.ok(state.open);
      const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`)),
        sponsorHash = digest(f.store.entries("sponsor:"));
      await actualLogout(f);
      gate.release();
      await rejected;
      assert.deepEqual(f.responses, [
        { status: 409, value: { error: "karaoke_session_changed" } },
      ]);
      await assert.rejects(port.ticket());
      await unchanged(f, state, ticketHash, sponsorHash);
    } finally {
      gate.release();
      await pending?.catch(() => undefined);
      port.dispose();
      await f.dispose();
    }
  });

test("POST CSRF replacement after reservation is uncertain409, never pre-handler403 refusal", async () => {
  const f = await readRecoveryFixture(),
    gate = holdPrepare(f, "body");
  let pending: Promise<Response> | undefined;
  try {
    pending = f.create();
    await gate.entered;
    const state = await f.walletState();
    assert.ok(state.open);
    const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`)),
      sponsorHash = digest(f.store.entries("sponsor:"));
    await f.db
      .prepare(
        "UPDATE community_sessions SET csrf_token='changed' WHERE session_hash=?",
      )
      .bind(sessionHash(f))
      .run();
    gate.release();
    await denied(await pending);
    await unchanged(f, state, ticketHash, sponsorHash);
  } finally {
    gate.release();
    await pending?.catch(() => undefined);
    await f.dispose();
  }
});

test("required final HTTP serialization rereads session after core recovery already returned", async (t) => {
  const f = await readRecoveryFixture();
  try {
    const state = await original(f, "interrupted");
    assert.ok(state.open);
    const expose = KaraokeRequestSession.prototype.expose;
    t.mock.method(
      KaraokeRequestSession.prototype,
      "expose",
      async function (
        this: KaraokeRequestSession,
        learner: Parameters<KaraokeRequestSession["expose"]>[0],
        serialize: Parameters<KaraokeRequestSession["expose"]>[1],
      ) {
        await actualLogout(f); // actual route, after all core proof/fence awaits
        return expose.call(this, learner, serialize);
      },
    );
    const response = await f.get();
    await denied(response);
    assert.deepEqual(await f.walletState(), state);
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

test("expiry during actual D1 session-read acknowledgement is denied after the await", async (t) => {
  const f = await readRecoveryFixture();
  let wall = Date.now();
  t.mock.method(Date, "now", () => wall);
  try {
    const state = await original(f, "missing"),
      current = await sessionRow(f);
    assert.ok(current);
    const session = { ...current, expires_at: wall + 1000 };
    await f.db
      .prepare(
        "UPDATE community_sessions SET expires_at=? WHERE session_hash=?",
      )
      .bind(session.expires_at, session.session_hash)
      .run();
    let reads = 0;
    const db = f.env.DB;
    f.env.DB = new Proxy(db, {
      get(target, key) {
        if (key !== "prepare") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(st, {
              get(statement, property) {
                if (property === "bind")
                  return (...values: unknown[]) =>
                    wrap(statement.bind(...values));
                if (
                  property === "first" &&
                  sql.includes("FROM community_sessions s")
                )
                  return async () => {
                    const row = await statement.first();
                    if (++reads === 2) wall = session.expires_at; // initial auth passed; reread ack is now late
                    return row;
                  };
                const value = Reflect.get(statement, property);
                return typeof value === "function"
                  ? value.bind(statement)
                  : value;
              },
            });
          return wrap(target.prepare(sql));
        };
      },
    });
    await denied(await f.get());
    assert.equal(reads, 2);
    assert.equal(f.counts.prepareDispatches, 0);
    assert.deepEqual(await f.walletState(), state);
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

for (const logout of [false, true])
  test(`concurrent canonical GETs share original durable prepare and ${logout ? "both deny after logout" : "both succeed with live session"}`, async () => {
    const f = await readRecoveryFixture(),
      both = deferred(),
      release = deferred();
    let pending: Promise<Response>[] = [];
    try {
      const state = await original(f, "missing");
      assert.ok(state.open);
      let prepared = 0;
      f.afterPrepare(async () => {
        if (++prepared === 2) both.resolve();
        await release.promise;
      });
      pending = [f.get(), f.get()];
      await both.promise;
      const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`)),
        sponsorHash = digest(f.store.entries("sponsor:"));
      if (logout) await actualLogout(f);
      release.resolve();
      for (const response of await Promise.all(pending)) {
        if (logout) await denied(response);
        else {
          assert.equal(response.status, 200);
          const view = (await response.json()) as {
            state: string;
            ticket: Signed<Ticket>;
            proof: `0x${string}`;
          };
          assert.equal(view.state, "open");
          assert.equal(digest(view.ticket), ticketHash);
          assert.equal(
            await verifyMessage({
              address: state.open.sessionKey,
              message: `connect:${state.open.ticketId}`,
              signature: view.proof,
            }),
            true,
          );
        }
      }
      await unchanged(f, state, ticketHash, sponsorHash);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await f.dispose();
    }
  });

test("actual scoped recovery refuses absent and structural always-allow session capability", async () => {
  const f = await readRecoveryFixture();
  try {
    const state = await original(f, "missing");
    for (const requestSession of [
      undefined,
      { check: async () => {}, expose: async () => Response.json({}) },
    ]) {
      const ports = { ...f.ports, env: f.env, db: f.env.DB, requestSession };
      await assert.rejects(
        karaokeAttempt(
          ports,
          { account_id: "a", wallet: f.wallet },
          f.postId as `0x${string}`,
        ),
        /karaoke_request_session_required/,
      );
    }
    assert.equal(f.counts.prepareDispatches, 0);
    assert.deepEqual(await f.walletState(), state);
  } finally {
    await f.dispose();
  }
});

test("response serialized before logout is the allowed final linearization; delivered bearer proof is not claimed revoked", async (t) => {
  const f = await readRecoveryFixture();
  try {
    const state = await original(f, "interrupted");
    assert.ok(state.open);
    const expose = KaraokeRequestSession.prototype.expose;
    t.mock.method(
      KaraokeRequestSession.prototype,
      "expose",
      async function (
        this: KaraokeRequestSession,
        learner: Parameters<KaraokeRequestSession["expose"]>[0],
        serialize: Parameters<KaraokeRequestSession["expose"]>[1],
      ) {
        const built = await expose.call(this, learner, serialize); // actual final check + synchronous JSON build
        await actualLogout(f); // deliberately later than the allowed observation/build
        return built;
      },
    );
    const response = await f.get();
    assert.equal(response.status, 200);
    const view = (await response.json()) as {
      ticket: Signed<Ticket>;
      proof: `0x${string}`;
    };
    assert.equal(view.ticket.body.ticketId, state.open.ticketId);
    assert.equal(
      await verifyMessage({
        address: state.open.sessionKey,
        message: `connect:${state.open.ticketId}`,
        signature: view.proof,
      }),
      true,
    );
    assert.equal(await sessionRow(f), null);
    assert.deepEqual(await f.walletState(), state);
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

test("ticket expiry at final session-serialization wait is denied at exact boundary", async (t) => {
  const f = await readRecoveryFixture();
  try {
    const state = await original(f, "interrupted");
    assert.ok(state.open);
    const expose = KaraokeRequestSession.prototype.expose;
    t.mock.method(
      KaraokeRequestSession.prototype,
      "expose",
      async function (
        this: KaraokeRequestSession,
        learner: Parameters<KaraokeRequestSession["expose"]>[0],
        serialize: Parameters<KaraokeRequestSession["expose"]>[1],
      ) {
        f.time(state.open!.expiresAt); // after core checks, before final actual D1 reread/serialization
        return expose.call(this, learner, serialize);
      },
    );
    const response = await f.get();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "karaoke_reservation_expired",
    });
    assert.deepEqual(await f.walletState(), state);
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

for (const mode of ["ack", "body"] as const)
  test(`held ${mode} with current live cookie returns original authenticated proof, positive control`, async () => {
    const f = await readRecoveryFixture();
    let gate: ReturnType<typeof holdPrepare> | undefined,
      pending: Promise<Response> | undefined;
    try {
      const state = await original(f, "interrupted");
      assert.ok(state.open);
      gate = holdPrepare(f, mode);
      pending = f.get();
      await gate.entered;
      const ticketHash = digest(await f.row(`ticket:${state.open.ticketId}`)),
        sponsorHash = digest(f.store.entries("sponsor:"));
      gate.release();
      const response = await pending;
      assert.equal(response.status, 200);
      const view = (await response.json()) as {
        state: string;
        ticket: Signed<Ticket>;
        proof: `0x${string}`;
      };
      assert.equal(view.state, "open");
      assert.equal(digest(view.ticket), ticketHash);
      assert.equal(
        await verifyMessage({
          address: state.open.sessionKey,
          message: `connect:${state.open.ticketId}`,
          signature: view.proof,
        }),
        true,
      );
      assert.ok(await sessionRow(f));
      await unchanged(f, state, ticketHash, sponsorHash);
    } finally {
      gate?.release();
      await pending?.catch(() => undefined);
      await f.dispose();
    }
  });
