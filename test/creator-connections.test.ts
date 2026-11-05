import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { communityRuntime } from "./community-runtime.ts";
import {
  accountSession,
  ensureCommunityIdentity,
  loginChallenge,
  loginVerify,
} from "../packages/community/accounts.ts";
import { canonical, hashJson } from "../packages/community/common.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import {
  authorizeCreatorRequest,
  signCreatorRequest,
} from "../packages/community/creator-service.ts";
import {
  creatorOperator,
  creatorServiceOrigin,
  verifyCreatorReceipt,
} from "../packages/community/creator-receipt.ts";
import {
  beginCreatorConnection,
  completeCreatorConnection,
  pendingCreatorConnection,
  retainCreatorBinding,
} from "../packages/community/creator-connections.ts";

const publisher = privateKeyToAccount(`0x${"11".repeat(32)}`),
  operatorFixture = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)),
  otherOperatorFixture = Ed25519Keypair.fromSecretKey(
    new Uint8Array(32).fill(8),
  ),
  origin = "https://community.example";
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
  app: { ...deployment.configuration.app, origin },
  feed: { ...deployment.configuration.feed, endpoint: origin + "/api/feed" },
});
async function fixture() {
  const runtime = await communityRuntime(),
    context = { origin, communityId: config.communityId };
  try {
    await ensureCommunityIdentity(runtime.db, context);
    const challenge = await loginChallenge(
        runtime.db,
        context,
        publisher.address,
      ),
      // Account/session fixture only. Signature verification is independently
      // exercised below for both publisher requests and native binding receipts.
      login = await loginVerify(
        runtime.db,
        context,
        challenge.id,
        "0x1234",
        async () => true,
      ),
      session = await accountSession(
        new Request(origin, {
          headers: { cookie: login.cookie.split(";")[0]! },
        }),
        runtime.db,
        context,
      );
    const nativeLaunches = new Set<string>();
    let loseResponse = true;
    const service = {
      config,
      publisher,
      transport: async (request: Request) => {
        assert.equal(new URL(request.url).origin, creatorServiceOrigin);
        const wire = await request.json(),
          verified = await authorizeCreatorRequest(
            wire,
            "creator_launch",
            creatorServiceOrigin,
            async () => config,
          ),
          b = verified.body,
          requestId = hashJson({
            communityId: config.communityId,
            connectionId: b.connectionId,
          }).slice(2);
        assert.ok(!JSON.stringify(b).includes(session.account_id));
        assert.ok(!JSON.stringify(b).includes(session.author_id));
        nativeLaunches.add(requestId);
        if (loseResponse) {
          loseResponse = false;
          throw new Error(
            "explicit fixture: response lost after native persistence",
          );
        }
        return Response.json({
          requestId,
          url: `${creatorServiceOrigin}/wallet?request=${requestId}`,
        });
      },
    };
    return { ...runtime, session, service, nativeLaunches };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
async function signedReceipt(
  session: Awaited<ReturnType<typeof fixture>>["session"],
  connection: { connectionId: string; state: string | null; url: string },
  changed: Record<string, unknown> = {},
  allowExpiredForRecovery = false,
) {
  assert.ok(connection.state);
  const requestId = new URL(connection.url).searchParams.get("request")!,
    now = Date.now(),
    payload = {
      schema: "pirate.creator-binding/1",
      network: "sui-ika-testnet",
      serviceOrigin: creatorServiceOrigin,
      communityId: config.communityId,
      communityOrigin: origin,
      connectionId: connection.connectionId,
      requestId,
      accountRef: hashJson({
        schema: "pirate.creator-account/1",
        communityId: config.communityId,
        accountId: session.account_id,
      }),
      state: connection.state,
      credentialRef: `0x${"a".repeat(64)}`,
      suiAddress: `0x${"b".repeat(64)}`,
      dWalletId: `0x${"c".repeat(64)}`,
      capabilityId: `0x${"d".repeat(64)}`,
      shareId: `0x${"e".repeat(64)}`,
      evmAddress: `0x${"1".repeat(40)}`,
      operatorFunded: true,
      verifiedAt: now,
      expiresAt: now + 300000,
      ...changed,
    },
    signed = await operatorFixture.signPersonalMessage(
      new TextEncoder().encode(canonical(payload)),
    ),
    wire = { payload, signature: signed.signature },
    expected = {
      communityId: config.communityId,
      communityOrigin: origin,
      connectionId: connection.connectionId,
      requestId,
      accountRef: payload.accountRef,
      state: connection.state,
    };
  const receipt = await verifyCreatorReceipt(
    wire,
    expected,
    now,
    operatorFixture.toSuiAddress(),
    allowExpiredForRecovery,
  );
  return { receipt, wire, expected, now };
}

test("creator requests bind publisher, exact body, service, current authority and expiry", async () => {
  const now = Math.floor(Date.now() / 1000),
    body = { connectionId: crypto.randomUUID() },
    wire = await signCreatorRequest(
      publisher,
      {
        action: "creator_launch",
        communityId: config.communityId,
        communityOrigin: origin,
        serviceOrigin: creatorServiceOrigin,
        configurationRevision: 1,
        nonce: `0x${"a".repeat(64)}`,
        issuedAt: now,
        expiresAt: now + 300,
      },
      body,
    );
  await authorizeCreatorRequest(
    wire,
    "creator_launch",
    creatorServiceOrigin,
    async () => config,
  );
  for (const changed of [
    { ...wire, body: { connectionId: crypto.randomUUID() } },
    {
      ...wire,
      authorization: {
        ...wire.authorization,
        serviceOrigin: "https://attacker.example",
      },
    },
    {
      ...wire,
      authorization: { ...wire.authorization, action: "creator_exchange" },
    },
  ])
    await assert.rejects(
      authorizeCreatorRequest(
        changed,
        "creator_launch",
        creatorServiceOrigin,
        async () => config,
      ),
    );
  await assert.rejects(
    authorizeCreatorRequest(
      wire,
      "creator_launch",
      creatorServiceOrigin,
      async () => ({ ...config, configurationRevision: 2 }),
    ),
    /creator_community_authority_changed/,
  );
  await assert.rejects(
    authorizeCreatorRequest(
      wire,
      "creator_launch",
      creatorServiceOrigin,
      async () => config,
      now + 301,
    ),
    /expired_creator_request/,
  );
});

test("lost launch responses and concurrent reloads preserve one private connection and native identity", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      beginCreatorConnection(f.db, f.session, f.service),
      /response lost/,
    );
    const pending = await pendingCreatorConnection(f.db, f.session);
    assert.ok(pending);
    const connections = await Promise.all(
      Array.from({ length: 6 }, () =>
        beginCreatorConnection(f.db, f.session, f.service),
      ),
    );
    assert.ok(
      connections.every(
        (c) =>
          c.connectionId === pending.connectionId && c.state === pending.state,
      ),
    );
    assert.equal(f.nativeLaunches.size, 1);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM creator_connections")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.ok(connections.every((c) => !Object.hasOwn(c, "verifier")));
  } finally {
    await f.dispose();
  }
});

test("native receipt signature, scope and age are checked before atomic binding; retries never replace the creator", async () => {
  const f = await fixture();
  try {
    await assert.rejects(beginCreatorConnection(f.db, f.session, f.service));
    const connection = await beginCreatorConnection(f.db, f.session, f.service),
      proof = await signedReceipt(f.session, connection);
    assert.notEqual(operatorFixture.toSuiAddress(), creatorOperator);
    await assert.rejects(
      verifyCreatorReceipt(proof.wire, proof.expected, proof.now),
    ); // fixture key is never the live operator
    await assert.rejects(
      verifyCreatorReceipt(
        proof.wire,
        { ...proof.expected, state: "wrong" },
        proof.now,
        operatorFixture.toSuiAddress(),
      ),
      /scope_mismatch/,
    );
    await assert.rejects(
      verifyCreatorReceipt(
        proof.wire,
        proof.expected,
        proof.now + 300001,
        operatorFixture.toSuiAddress(),
      ),
      /expired/,
    );
    const bad = await otherOperatorFixture.signPersonalMessage(
      new TextEncoder().encode(canonical(proof.wire.payload)),
    );
    await assert.rejects(
      verifyCreatorReceipt(
        { ...proof.wire, signature: bad.signature },
        proof.expected,
        proof.now,
        operatorFixture.toSuiAddress(),
      ),
      /invalid_creator_receipt_signature/,
    );
    await retainCreatorBinding(
      f.db,
      f.session,
      connection.connectionId,
      proof.receipt,
    );
    await retainCreatorBinding(
      f.db,
      f.session,
      connection.connectionId,
      proof.receipt,
    );
    const before = await f.db.prepare("SELECT * FROM creator_bindings").first();
    const restored = await completeCreatorConnection(
      f.db,
      f.session,
      {
        ...f.service,
        transport: async () => {
          throw new Error("must not call native service twice");
        },
      },
      connection.connectionId,
      connection.state!,
    );
    assert.equal(restored.state, "connected");
    await assert.rejects(
      completeCreatorConnection(
        f.db,
        f.session,
        f.service,
        connection.connectionId,
        "wrong",
      ),
      /state_mismatch/,
    );
    await assert.rejects(
      completeCreatorConnection(
        f.db,
        { ...f.session, session_hash: "different-session" },
        f.service,
        connection.connectionId,
        connection.state!,
      ),
      /not_found/,
    );
    const next = await beginCreatorConnection(f.db, f.session, f.service),
      changed = await signedReceipt(f.session, next, {
        credentialRef: `0x${"9".repeat(64)}`,
      });
    await assert.rejects(
      retainCreatorBinding(f.db, f.session, next.connectionId, changed.receipt),
    );
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM creator_bindings").first(),
      before,
    );
    assert.equal(
      (await f.db
        .prepare(
          "SELECT consumed FROM creator_connections WHERE connection_id=?",
        )
        .bind(next.connectionId)
        .first<{ consumed: number }>())!.consumed,
      0,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("a lost native receipt older than five minutes is preserved and retired before a fresh approval, without DKG", async () => {
  const f = await fixture();
  try {
    await assert.rejects(beginCreatorConnection(f.db, f.session, f.service));
    const connection = await beginCreatorConnection(f.db, f.session, f.service),
      now = Date.now(),
      // The original response was persisted six minutes before it can be
      // delivered. It must never acquire a fresh verifiedAt on retry.
      proof = await signedReceipt(
        f.session,
        connection,
        { verifiedAt: now - 360000, expiresAt: now - 60000 },
        true,
      ),
      originalId = new URL(connection.url).searchParams.get("request");
    let exchanges = 0;
    const service = {
      ...f.service,
      verifyReceipt: (
        input: unknown,
        expected: Parameters<typeof verifyCreatorReceipt>[1],
        at = Date.now(),
        _operator?: string,
        allowExpired = false,
      ) =>
        verifyCreatorReceipt(
          input,
          expected,
          at,
          operatorFixture.toSuiAddress(),
          allowExpired,
        ),
      transport: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith("/launch"))
          return f.service.transport(request);
        const wire = await request.json(),
          verified = await authorizeCreatorRequest(
            wire,
            "creator_exchange",
            creatorServiceOrigin,
            async () => config,
          );
        if (verified.body.requestId !== originalId)
          return Response.json({ state: "waiting" });
        exchanges++;
        if (exchanges === 1)
          throw new Error(
            "explicit fixture: native receipt persisted, response lost",
          );
        return Response.json({ state: "connected", receipt: proof.wire });
      },
    };
    await assert.rejects(
      completeCreatorConnection(
        f.db,
        f.session,
        service,
        connection.connectionId,
        connection.state!,
      ),
      /response lost/,
    );
    const recovered = await completeCreatorConnection(
      f.db,
      f.session,
      service,
      connection.connectionId,
      connection.state!,
    );
    assert.equal(recovered.state, "verification_expired");
    const saved = await f.db
      .prepare("SELECT * FROM creator_connections WHERE connection_id=?")
      .bind(connection.connectionId)
      .first<{
        consumed: number;
        verifier_secret: string | null;
        receipt_json: string | null;
        expired_receipt_json: string;
      }>();
    assert.equal(saved!.consumed, 1);
    assert.equal(saved!.verifier_secret, null);
    assert.equal(saved!.receipt_json, null);
    assert.equal(saved!.expired_receipt_json, canonical(proof.receipt));
    assert.equal(
      JSON.parse(saved!.expired_receipt_json).payload.verifiedAt,
      now - 360000,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM creator_bindings")
        .first<{ n: number }>())!.n,
      0,
    );
    await assert.rejects(
      retainCreatorBinding(
        f.db,
        f.session,
        connection.connectionId,
        proof.receipt,
      ),
      /expired/,
    );
    const next = await beginCreatorConnection(f.db, f.session, service);
    assert.notEqual(next.connectionId, connection.connectionId);
    assert.equal(f.nativeLaunches.size, 2);
    assert.equal(
      (
        await completeCreatorConnection(
          f.db,
          f.session,
          service,
          next.connectionId,
          next.state!,
        )
      ).state,
      "waiting",
    );
    assert.equal(
      (
        await completeCreatorConnection(
          f.db,
          f.session,
          service,
          connection.connectionId,
          connection.state!,
        )
      ).state,
      "verification_expired",
    );
    assert.equal(exchanges, 2);
  } finally {
    await f.dispose();
  }
});

test("a native credential-claim denial retires its request and lets the session choose another wallet", async () => {
  const f = await fixture();
  try {
    await assert.rejects(beginCreatorConnection(f.db, f.session, f.service));
    const connection = await beginCreatorConnection(f.db, f.session, f.service);
    let denials = 0;
    const service = {
      ...f.service,
      transport: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith("/launch"))
          return f.service.transport(request);
        denials++;
        return Response.json(
          { error: "creator_credential_claimed" },
          { status: 409 },
        );
      },
    };
    assert.equal(
      (
        await completeCreatorConnection(
          f.db,
          f.session,
          service,
          connection.connectionId,
          connection.state!,
        )
      ).state,
      "choose_another_wallet",
    );
    assert.equal(
      (
        await completeCreatorConnection(
          f.db,
          f.session,
          service,
          connection.connectionId,
          connection.state!,
        )
      ).state,
      "choose_another_wallet",
    );
    assert.equal(denials, 1);
    const old = await f.db
      .prepare(
        "SELECT consumed,retired_reason,verifier_secret FROM creator_connections WHERE connection_id=?",
      )
      .bind(connection.connectionId)
      .first<{
        consumed: number;
        retired_reason: string;
        verifier_secret: string | null;
      }>();
    assert.equal(old!.consumed, 1);
    assert.equal(old!.retired_reason, "creator_credential_claimed");
    assert.equal(old!.verifier_secret, null);
    const next = await beginCreatorConnection(f.db, f.session, service);
    assert.notEqual(next.connectionId, connection.connectionId);
    assert.equal(f.nativeLaunches.size, 2);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM creator_bindings")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});
