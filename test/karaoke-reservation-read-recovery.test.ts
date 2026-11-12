// UNRUN proposal against a9944772. Real canonical GET, HTTP fences, D1 CAS,
// actual operator route/signatures/SQLite; ABI chain observations are simulated.
// The original successful 409/manual-reconciliation witness is untouched.
import test from "node:test";
import { verifyMessage } from "viem";
import assert from "node:assert/strict";
import {
  digest,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import { createOperatorKaraokePort } from "../apps/web/src/karaoke/operator-karaoke-adapter.ts";
import { createKaraokeCaptureController } from "../packages/karaoke/capture-controller.ts";
import {
  KaraokeOperatorAudioClient,
  type KaraokeOperatorSocket,
} from "../packages/karaoke/operator-audio-client.ts";
import { readRecoveryFixture } from "./karaoke-reservation-read-fixture.ts";
const changedAddress = `0x${"dd".repeat(20)}` as const;

test("first POST commits without signed row; first canonical GET alone reconstructs and prepares original reservation", async () => {
  const f = await readRecoveryFixture();
  try {
    f.fault("cas");
    assert.equal((await f.create()).status, 409);
    const original = await f.walletState();
    assert.ok(original.open);
    assert.equal(await f.row(`ticket:${original.open.ticketId}`), undefined);
    assert.equal(f.counts.prepareDispatches, 0);
    const response = await f.get();
    assert.equal(response.status, 200);
    const view = (await response.json()) as {
      state: string;
      ticket: Signed<Ticket>;
      proof: string;
    };
    assert.equal(view.state, "open");
    assert.ok(view.proof);
    assert.equal(view.ticket.body.ticketId, original.open.ticketId);
    assert.equal(view.ticket.body.sessionKey, original.open.sessionKey);
    assert.equal(
      await verifyMessage({
        address: original.open.sessionKey,
        message: `connect:${original.open.ticketId}`,
        signature: view.proof as `0x${string}`,
      }),
      true,
    );
    assert.equal(
      digest(f.store.get(`ticket:${original.open.ticketId}`)),
      digest(view.ticket),
    );
    assert.equal(view.ticket.body.quoteId, original.open.quoteId);
    assert.equal(
      view.ticket.body.authorizationId,
      original.open.authorizationId,
    );
    assert.equal(view.ticket.body.manifestSha256, original.open.manifestSha256);
    assert.equal(view.ticket.body.issuedAt, original.open.issuedAt);
    assert.equal(view.ticket.body.expiresAt, original.open.expiresAt);
    assert.deepEqual(await f.walletState(), original);
    assert.equal(f.counts.ticketPosts, 1);
    assert.equal(f.counts.casCommits, 1);
  } finally {
    await f.dispose();
  }
});

for (const bodyFailure of [false, true])
  test(`delayed real409 body${bodyFailure ? " failure" : ""} after CAS commit races canonical recovery without replay`, async () => {
    const f = await readRecoveryFixture(),
      actualFetch = globalThis.fetch;
    const port = createOperatorKaraokePort({
      account: f.wallet,
      postId: f.postId,
      csrf: () => f.auth["x-csrf-token"],
    });
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodyReady = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const response = await actualFetch(input, init);
      if (input !== "/api/karaoke/tickets") return response;
      assert.equal(response.status, 409);
      return new Proxy(response, {
        get(target, key) {
          if (key === "json")
            return async () => {
              arrived();
              await gate;
              if (bodyFailure) throw Error("fixture_late_body_lost");
              return target.json();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof fetch;
    try {
      f.fault("cas");
      const pending = port.ticket();
      await bodyReady;
      const original = await f.walletState();
      assert.ok(original.open);
      assert.equal(await f.row(`ticket:${original.open.ticketId}`), undefined);
      assert.equal(port.ticket(), pending);
      // Controlled interleaving: ordinary authenticated GET finishes recovery
      // while the original POST response body has not resolved yet.
      assert.equal((await f.get()).status, 200);
      release();
      assert.equal((await pending).ticketId, original.open.ticketId);
      assert.deepEqual(await f.walletState(), original);
      assert.equal(f.counts.ticketPosts, 1);
      assert.equal(f.counts.casCommits, 1);
    } finally {
      release();
      port.dispose();
      await f.dispose();
    }
  });

test("actual committed409 remains held through stale empty/finished observations; authoritative canonical GET resumes original", async () => {
  const f = await readRecoveryFixture(),
    actualFetch = globalThis.fetch;
  const port = createOperatorKaraokePort({
    account: f.wallet,
    postId: f.postId,
    csrf: () => f.auth["x-csrf-token"],
  });
  let observation: "none" | "finished" | "canonical" = "none";
  globalThis.fetch = (async (input, init) => {
    if (
      String(input).startsWith("/api/karaoke/attempt") &&
      observation !== "canonical"
    )
      return Response.json({ state: observation });
    return actualFetch(input, init);
  }) as typeof fetch;
  try {
    f.fault("cas");
    await assert.rejects(port.ticket(), /confirm this take/);
    const original = await f.walletState();
    assert.ok(original.open);
    await assert.rejects(port.ticket(), /confirm this take/);
    observation = "finished";
    await assert.rejects(port.ticket(), /confirm this take/);
    assert.equal(f.counts.ticketPosts, 1);
    observation = "canonical";
    assert.equal((await port.ticket()).ticketId, original.open.ticketId);
    assert.equal(f.counts.ticketPosts, 1);
    assert.equal(f.counts.casCommits, 1);
    assert.deepEqual(await f.walletState(), original);
  } finally {
    port.dispose();
    await f.dispose();
  }
});

test("CAS commit/lost acknowledgement409 recovers only through ordinary canonical GET; no second browser or backend create", async () => {
  const f = await readRecoveryFixture();
  const port = createOperatorKaraokePort({
    account: f.wallet,
    postId: f.postId,
    csrf: () => f.auth["x-csrf-token"],
  });
  try {
    f.fault("cas");
    f.fault("beforePrepare");
    await assert.rejects(port.ticket(), /confirm this take/);
    const original = await f.walletState();
    assert.equal(original.sequence, 1);
    assert.ok(original.open?.recoveryScope);
    // The adapter's first canonical GET has already rebuilt the missing row,
    // but preparation still fails and no proof was accepted.
    assert.ok(await f.row(`ticket:${original.open.ticketId}`));
    assert.deepEqual(f.responses, [
      { status: 409, value: { error: "fixture_reservation_ack_lost" } },
    ]);
    await assert.rejects(port.ticket());
    assert.equal(f.counts.ticketPosts, 1);
    f.releasePrepare();
    const resumed = await port.ticket();
    assert.equal(resumed.ticketId, original.open.ticketId);
    assert.equal(f.counts.ticketPosts, 1);
    assert.equal(f.counts.casCommits, 1);
    assert.deepEqual(await f.walletState(), original);
    const ticket = await f.row<Signed<Ticket>>(`ticket:${resumed.ticketId}`);
    assert.ok(ticket);
    const ticketHash = digest(ticket),
      sponsor = digest(f.store.entries("sponsor:"));
    assert.equal((await port.ticket()).ticketId, resumed.ticketId);
    assert.equal(digest(await f.row(`ticket:${resumed.ticketId}`)), ticketHash);
    assert.equal(digest(f.store.entries("sponsor:")), sponsor);
    assert.equal(f.counts.ticketPosts, 1);
    assert.deepEqual(await f.walletState(), original);
    assert.ok(await f.row(`karaokePreparedV1:${resumed.ticketId}`));
  } finally {
    port.dispose();
    await f.dispose();
  }
});

for (const fault of [
  "beforePrepare",
  "prepareAck",
  "communityAck",
  "communityAckLost",
  "operatorAck",
] as const)
  test(`signed row exists and ${fault} interrupts preparation; canonical GET idempotently resumes original bytes`, async () => {
    const f = await readRecoveryFixture();
    try {
      f.fault(fault);
      const first = await f.create();
      assert.notEqual(first.status, 200);
      const original = await f.walletState();
      assert.ok(original.open);
      const ticket = await f.row<Signed<Ticket>>(
        `ticket:${original.open.ticketId}`,
      );
      assert.ok(ticket);
      // No connection proof has escaped the failed preparation response.
      assert.equal(Object.hasOwn(await first.json(), "proof"), false);
      const before = digest(ticket),
        sponsorBefore = digest(f.store.entries("sponsor:"));
      f.releasePrepare();
      const recovered = await f.get();
      assert.equal(
        recovered.status,
        200,
        JSON.stringify(await recovered.clone().json()),
      );
      const view = (await recovered.json()) as {
        state: string;
        ticket: Signed<Ticket>;
        proof: string;
      };
      assert.equal(view.state, "open");
      assert.equal(view.ticket.body.ticketId, original.open.ticketId);
      assert.ok(view.proof);
      assert.equal(digest(view.ticket), before);
      assert.deepEqual(await f.walletState(), original);
      assert.equal(f.counts.ticketPosts, 1);
      assert.equal(f.counts.casCommits, 1);
      const stable = digest(f.store.entries("sponsor:"));
      if (fault !== "beforePrepare") assert.equal(stable, sponsorBefore);
      const ack = digest(
        f.store.get(`karaokePreparedV1:${original.open.ticketId}`),
      );
      assert.equal((await f.get()).status, 200);
      assert.equal(
        digest(f.store.get(`karaokePreparedV1:${original.open.ticketId}`)),
        ack,
      );
      assert.equal(digest(f.store.entries("sponsor:")), stable);
      assert.deepEqual(await f.walletState(), original);
    } finally {
      await f.dispose();
    }
  });

test("actual cookie, expected-account, Origin and CSRF checks precede reservation/proof work", async () => {
  const f = await readRecoveryFixture();
  try {
    const deniedHeaders: Record<string, string>[] = [
      {},
      { cookie: f.auth.cookie },
      { ...f.auth, "x-study-account": "0x" + "ee".repeat(20) },
    ];
    for (const headers of deniedHeaders) {
      const response = await f.get(headers);
      assert.notEqual(response.status, 200);
      assert.equal(Object.hasOwn(await response.json(), "proof"), false);
    }
    for (const headers of [
      { ...f.auth, "x-csrf-token": "wrong" },
      { ...f.auth, origin: "https://other.invalid" },
      { ...f.auth, "sec-fetch-site": "cross-site" },
    ])
      assert.equal(
        (await f.post("/api/karaoke/tickets", { postId: f.postId }, headers))
          .status,
        403,
      );
    assert.equal(f.counts.prepareDispatches, 0);
    assert.equal(f.counts.casCommits, 0);
    assert.equal(
      await f.db.prepare("SELECT COUNT(*) AS n FROM karaoke_state").first("n"),
      0,
    );
    // Positive control uses the same real cookie/account/CSRF/Origin protocol.
    assert.equal((await f.create()).status, 200);
    assert.equal((await f.get()).status, 200);
  } finally {
    await f.dispose();
  }
});

for (const negative of [
  "revoked",
  "owner",
  "authorizationRow",
  "authorizationId",
  "target",
  "community",
  "operator",
  "operatorOrigin",
  "issuer",
  "quote",
  "expiry",
] as const)
  test(`current ${negative} fence refuses reconstruction/preparation/proof without changing original reservation`, async () => {
    const f = await readRecoveryFixture();
    try {
      // First request commits scope, no signed row and no operator preparation.
      f.fault("cas");
      assert.equal((await f.create()).status, 409);
      const original = await f.walletState();
      assert.ok(original.open);
      if (negative === "revoked") f.revoke();
      if (negative === "owner") f.wrongOwner();
      if (negative === "authorizationRow")
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET issued_at=101 WHERE authorization_id=?",
          )
          .bind(original.open.authorizationId)
          .run();
      if (negative === "authorizationId")
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET authorization_id=? WHERE authorization_id=?",
          )
          .bind("0x" + "cd".repeat(32), original.open.authorizationId)
          .run();
      if (negative === "target")
        f.env.STUDY_RESULTS_V4_CONTRACT = changedAddress;
      if (negative === "community")
        f.env.KARAOKE_COMMUNITY_ADDRESS = changedAddress;
      if (negative === "operator")
        f.env.KARAOKE_OPERATOR_ADDRESS = changedAddress;
      if (negative === "operatorOrigin")
        f.env.KARAOKE_OPERATOR_ORIGIN = "https://changed.invalid";
      if (negative === "issuer") f.operatorEnv.ISSUER = changedAddress;
      if (negative === "quote") f.operatorEnv.QUOTE_VALID_UNTIL = "999";
      if (negative === "expiry") f.time(original.open.expiresAt); // exact boundary, not +1
      const response = await f.get();
      assert.notEqual(response.status, 200);
      assert.equal(Object.hasOwn(await response.json(), "proof"), false);
      assert.deepEqual(await f.walletState(), original);
      assert.equal(f.counts.ticketPosts, 1);
      assert.equal(f.counts.casCommits, 1);
      if (
        [
          "revoked",
          "authorizationRow",
          "authorizationId",
          "target",
          "community",
          "operator",
          "operatorOrigin",
          "expiry",
        ].includes(negative)
      ) {
        assert.equal(f.counts.prepareDispatches, 0);
        assert.equal(
          await f.row(`ticket:${original.open.ticketId}`),
          undefined,
        );
      }
    } finally {
      await f.dispose();
    }
  });

test("later sign-in does not move original authorization/cutoff or create another reservation", async () => {
  const f = await readRecoveryFixture();
  try {
    assert.equal((await f.create()).status, 200);
    const original = await f.walletState();
    assert.ok(original.open);
    await f.db
      .prepare(
        `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
      VALUES(?,'a',?,'{}','','0x',?,4,111,'recorded',0,0)`,
      )
      .bind("0x" + "cd".repeat(32), f.wallet, original.open.authorizationId)
      .run();
    f.time(112);
    const response = await f.get();
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { ticket: Signed<Ticket> }).ticket.body
        .authorizationId,
      original.open.authorizationId,
    );
    assert.deepEqual(await f.walletState(), original);
  } finally {
    await f.dispose();
  }
});

test("lost prepare acknowledgement followed by permission loss is held despite durable exact marker", async () => {
  const f = await readRecoveryFixture();
  try {
    f.fault("prepareAck");
    assert.notEqual((await f.create()).status, 200);
    const original = await f.walletState();
    assert.ok(original.open);
    const operatorAck = f.store.get(
      `karaokePreparedV1:${original.open.ticketId}`,
    );
    assert.ok(operatorAck);
    f.revoke();
    const response = await f.get();
    assert.notEqual(response.status, 200);
    assert.equal(Object.hasOwn(await response.json(), "proof"), false);
    assert.deepEqual(await f.walletState(), original);
    assert.equal(
      digest(f.store.get(`karaokePreparedV1:${original.open.ticketId}`)),
      digest(operatorAck),
    );
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

test("late permission/expiry change while real prepare acknowledgement returns cannot expose proof", async () => {
  for (const change of ["revoke", "expiry"] as const) {
    const f = await readRecoveryFixture();
    try {
      f.fault("cas");
      assert.equal((await f.create()).status, 409);
      const original = await f.walletState();
      assert.ok(original.open);
      f.afterPrepare(() =>
        change === "revoke" ? f.revoke() : f.time(original.open!.expiresAt),
      );
      const response = await f.get();
      assert.notEqual(response.status, 200);
      assert.equal(Object.hasOwn(await response.json(), "proof"), false);
      assert.deepEqual(await f.walletState(), original);
      assert.equal(f.counts.ticketPosts, 1);
    } finally {
      await f.dispose();
    }
  }
});

for (const location of ["community", "operator"] as const)
  test(`${location} stale/mismatched durable acknowledgement is denied and never repaired by overwriting`, async () => {
    const f = await readRecoveryFixture();
    try {
      assert.equal((await f.create()).status, 200);
      const original = await f.walletState();
      assert.ok(original.open);
      const key = `karaokePreparedV1:${original.open.ticketId}`;
      const bad = {
        scopeHash: "wrong-scope",
        acknowledgement: {
          kind: "karaoke_prepared_v1",
          body: { ticketId: "wrong-ticket" },
          signature: "0x",
        },
      };
      if (location === "community")
        await f.db
          .prepare("UPDATE karaoke_state SET value=? WHERE key=?")
          .bind(JSON.stringify(bad), key)
          .run();
      else f.store.set(key, bad.acknowledgement);
      assert.notEqual((await f.get()).status, 200);
      assert.equal(
        digest(location === "community" ? await f.row(key) : f.store.get(key)),
        digest(location === "community" ? bad : bad.acknowledgement),
      );
      assert.deepEqual(await f.walletState(), original);
    } finally {
      await f.dispose();
    }
  });

test("missing terminal proof and exact expiry keep original budget held, never replacement permission", async () => {
  const f = await readRecoveryFixture();
  try {
    assert.equal((await f.create()).status, 200);
    const original = await f.walletState();
    assert.ok(original.open);
    f.markTerminalPending();
    f.store.set(`attempt:${original.open.ticketId}`, {
      ended: { endedAt: 111 },
    });
    assert.notEqual((await f.get()).status, 200);
    f.time(original.open.expiresAt);
    assert.notEqual((await f.get()).status, 200);
    assert.deepEqual(await f.walletState(), original);
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

test("actual capture controller receives recovered original identity; socket reconnect never creates another ticket", async () => {
  const f = await readRecoveryFixture();
  const port = createOperatorKaraokePort({
    account: f.wallet,
    postId: f.postId,
    csrf: () => f.auth["x-csrf-token"],
  });
  let controller: ReturnType<typeof createKaraokeCaptureController> | undefined;
  try {
    f.fault("cas");
    f.fault("beforePrepare");
    await assert.rejects(port.ticket());
    f.releasePrepare();
    const take = await port.ticket();
    const sockets: Array<{ emit(type: string, value: unknown): void }> = [];
    const opened: string[] = [];
    const timers: (() => void)[] = [];
    const engine = {
      start: async () => {},
      activate: async (stamp?: number) => stamp ?? 1000,
      captureClockMs: () => 1000,
      deactivateAndFlush: async () => {},
      stop: async () => {},
    };
    controller = createKaraokeCaptureController({
      createCaptureEngine: () => engine,
      createClient: (hooks) =>
        new KaraokeOperatorAudioClient({
          ...hooks,
          ticketId: take.ticketId,
          setTimer: (callback) => {
            timers.push(callback);
            return timers.length;
          },
          openSocket: () => {
            opened.push(take.ticketId);
            const listeners = new Map<string, ((value: never) => void)[]>();
            const socket = {
              send() {},
              close() {},
              addEventListener(type: string, callback: (value: never) => void) {
                listeners.set(type, [...(listeners.get(type) ?? []), callback]);
              },
              emit(type: string, value: unknown) {
                listeners
                  .get(type)
                  ?.forEach((callback) => callback(value as never));
              },
            };
            sockets.push(socket);
            return socket as KaraokeOperatorSocket;
          },
        }),
    });
    await controller.start(0);
    sockets[0].emit("message", {
      data: JSON.stringify({
        type: "ready",
        attemptId: digest(take.ticketId),
        audioSequence: 0,
        resumed: false,
      }),
    });
    assert.equal(controller.getState().status, "active");
    sockets[0].emit("close", { code: 1006 });
    assert.equal(controller.getState().status, "reconnecting");
    assert.equal(timers.length, 1);
    timers.shift()!(); // Existing client's automatic reconnect, no wall-clock wait.
    sockets[1].emit("message", {
      data: JSON.stringify({
        type: "ready",
        attemptId: digest(take.ticketId),
        audioSequence: 0,
        resumed: true,
      }),
    });
    assert.equal(controller.getState().status, "active");
    assert.deepEqual(opened, [take.ticketId, take.ticketId]);
    assert.equal(f.counts.ticketPosts, 1);
    assert.equal(f.counts.casCommits, 1);
  } finally {
    controller?.dispose();
    port.dispose();
    await f.dispose();
  }
});

for (const changed of ["target", "community", "operator"] as const)
  test(`operator ${changed} change cannot reuse an old durable preparation acknowledgement`, async () => {
    const f = await readRecoveryFixture();
    try {
      assert.equal((await f.create()).status, 200);
      const original = await f.walletState();
      assert.ok(original.open);
      const before = digest(
        f.store.get(`karaokePreparedV1:${original.open.ticketId}`),
      );
      if (changed === "target")
        f.operatorEnv.RESULTS_V4_CONTRACT = changedAddress;
      if (changed === "community")
        f.operatorEnv.COMMUNITY_ADDRESS = changedAddress;
      if (changed === "operator")
        f.operatorEnv.OPERATOR_ADDRESS = changedAddress;
      const response = await f.get();
      assert.notEqual(response.status, 200);
      assert.equal(Object.hasOwn(await response.json(), "proof"), false);
      assert.equal(
        digest(f.store.get(`karaokePreparedV1:${original.open.ticketId}`)),
        before,
      );
      assert.deepEqual(await f.walletState(), original);
      assert.equal(f.counts.ticketPosts, 1);
    } finally {
      await f.dispose();
    }
  });

test("accepted pending operator withdrawal cannot reuse prepared receipt as current permission", async () => {
  const f = await readRecoveryFixture();
  try {
    assert.equal((await f.create()).status, 200);
    const original = await f.walletState();
    assert.ok(original.open);
    const ack = digest(
      f.store.get(`karaokePreparedV1:${original.open.ticketId}`),
    );
    f.store.set(
      `revocationIntent:4:${f.config.learningRecords.toLowerCase()}:${f.wallet}:fixture`,
      { pending: true },
    );
    const response = await f.get();
    assert.notEqual(response.status, 200);
    assert.equal(Object.hasOwn(await response.json(), "proof"), false);
    assert.deepEqual(await f.walletState(), original);
    assert.equal(
      digest(f.store.get(`karaokePreparedV1:${original.open.ticketId}`)),
      ack,
    );
    assert.equal(f.counts.ticketPosts, 1);
  } finally {
    await f.dispose();
  }
});

for (const signedRow of [false, true])
  test(`unscoped original V4 reservation with signedRow=${signedRow} is held without inferred backfill`, async () => {
    const f = await readRecoveryFixture();
    try {
      if (signedRow) assert.equal((await f.create()).status, 200);
      else {
        f.fault("cas");
        assert.equal((await f.create()).status, 409);
      }
      const legacy = await f.walletState();
      assert.ok(legacy.open);
      delete legacy.open.recoveryScope;
      await f.db
        .prepare("UPDATE karaoke_state SET value=? WHERE key=?")
        .bind(JSON.stringify(legacy), `wallet:${f.wallet}`)
        .run();
      const before = f.counts.prepareDispatches;
      const response = await f.get();
      assert.notEqual(response.status, 200);
      assert.equal(Object.hasOwn(await response.json(), "proof"), false);
      assert.equal(f.counts.prepareDispatches, before);
      assert.deepEqual(await f.walletState(), legacy);
      assert.equal(f.counts.ticketPosts, 1);
    } finally {
      await f.dispose();
    }
  });
