import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { recoverTypedDataAddress } from "viem";
import { preparePublicationGrant } from "../packages/protocol/publication-consent.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import {
  publicationAppFixture,
  learner,
  other,
} from "./fixtures/publication-app.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
const bounded = { timeout: 30000 };
async function scenario(
  t: TestContext,
  label: string,
  work: (f: Fixture) => Promise<void>,
  options: Parameters<typeof publicationAppFixture>[1] = {},
) {
  const f = await publicationAppFixture(t, options);
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}
test(
  "actual HTTP Origin, cookie and CSRF failures cannot create a publication command",
  bounded,
  async (t) =>
    scenario(t, "http-auth-denials", async (f) => {
      const invalidHeaders: Record<string, string>[] = [
        { origin: "https://foreign.invalid" },
        { cookie: "" },
        { "x-csrf-token": "wrong" },
        { cookie: "__Host-community_session=" + "b".repeat(64) },
      ];
      for (const headers of invalidHeaders) {
        const response = await f.call(
          "grants/prepare",
          { purpose: "study-results", requestId: "auth-failure" },
          headers,
        );
        assert.ok(
          response.status >= 400 && response.status < 500,
          JSON.stringify(response.value),
        );
        assert.equal(response.value.walletRequest, undefined);
        assert.equal((await f.rows()).length, 0);
        assert.equal(f.operatorCalls.length, 0);
      }
    }),
);

test(
  "first-song retains the real session while fresh publication stays disabled",
  bounded,
  async (t) =>
    scenario(
      t,
      "first-song-session",
      async (f) => {
        const capabilities = await f.call("capabilities");
        assert.equal(capabilities.status, 200);
        assert.equal(capabilities.value.profile, "first-song");
        assert.deepEqual(capabilities.value.purposes, []);
        const prepare = await f.prepare();
        assert.equal(prepare.status, 409);
        assert.equal(prepare.value.walletRequest, undefined);
        assert.equal((await f.rows()).length, 0);
        assert.equal((await f.call("capabilities")).status, 200);
        // This proves the real authenticated session remains usable. Full plain
        // login and private-practice user flows remain separate common-mount E2E.
      },
      { firstSong: true },
    ),
);

test(
  "concurrent actual HTTP prepares retain one original nonce and authenticated public capture",
  bounded,
  async (t) =>
    scenario(t, "concurrent-prepare", async (f) => {
      const replies = await Promise.all([
        f.prepare(),
        f.prepare(),
        f.prepare(),
      ]);
      for (const reply of replies)
        assert.equal(reply.status, 200, JSON.stringify(reply.value));
      const commands = replies.map((reply) =>
        parseCommand(reply.value.command),
      );
      assert.equal(new Set(commands.map((c) => c.commandId)).size, 1);
      assert.equal(new Set(commands.map((c) => c.message.nonce)).size, 1);
      const rows = await f.rows();
      assert.equal(rows.length, 1);
      const capture = JSON.parse(rows[0].request_json).capture;
      assert.equal(capture.learner, learner.address.toLowerCase());
      assert.equal(capture.bindingId, "binding");
      assert.equal(capture.accountId, "account");
      assert.equal(capture.sourceCommandId, null);
      for (const secret of [
        "cookie",
        "csrf_token",
        "csrf",
        "session_hash",
        "sessionHash",
      ])
        assert.equal(Object.hasOwn(capture, secret), false);
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal(f.store().get("op:nonce"), undefined);
    }),
);

test(
  "session removal during an actual held RPC read prevents wallet challenge exposure",
  bounded,
  async (t) =>
    scenario(t, "session-after-rpc", async (f) => {
      const gate = f.authority.holdRpc("eth_chainId"),
        pending = f.prepare();
      try {
        await gate.entered;
        await f.revokeSession();
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.ok([401, 409].includes(response.status));
      assert.equal(response.value.walletRequest, undefined);
      const rows = await f.rows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].typed_json, null);
      assert.equal(rows[0].signature, null);
      assert.equal(f.operatorCalls.length, 0);
    }),
);

test(
  "actual accepting D1 SQL refuses session loss after the last request check",
  bounded,
  async (t) =>
    scenario(t, "session-at-accepting-sql", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command),
        signature = await f.sign(c);
      const gate = f.holdMutation("SET phase='accepted'"),
        pending = f.submit({ commandId: c.commandId, signature });
      try {
        await gate.entered;
        await f.revokeSession();
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.ok(
        [401, 409].includes(response.status),
        JSON.stringify(response.value),
      );
      const row = (await f.rows())[0];
      assert.equal(row.phase, "prepared");
      assert.equal(row.signature, null);
      assert.equal(row.accepted_json, null);
      assert.equal(f.operatorCalls.length, 0);
    }),
);

test(
  "real typed and issuer signatures retain the first accepted body across HTTP replays",
  bounded,
  async (t) =>
    scenario(t, "first-signature-and-replay", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command);
      assert.equal(c.action, "grant");
      const signature = await f.sign(c),
        typed = preparePublicationGrant(
          31337n,
          c.source.registry,
          c.message,
          "0x",
        );
      assert.equal(
        (
          await recoverTypedDataAddress({ ...typed.typed, signature })
        ).toLowerCase(),
        learner.address.toLowerCase(),
      );
      const accepted = await f.submit({ commandId: c.commandId, signature });
      assert.equal(accepted.status, 200);
      const original = (await f.rows())[0];
      assert.equal(original.phase, "accepted");
      assert.equal(
        (accepted.value.receipt as { state: string }).state,
        "queued",
      );
      assert.equal(
        (await f.submit({ commandId: c.commandId, signature })).status,
        200,
      );
      const changed = await f.submit({
        commandId: c.commandId,
        signature: await f.sign(c, other),
      });
      assert.equal(changed.status, 409);
      const current = (await f.rows())[0];
      assert.equal(current.accepted_json, original.accepted_json);
      assert.equal(current.signature, signature);
      assert.equal(current.nonce_hex, original.nonce_hex);
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
      assert.ok(
        f.authority.state.calls.every(
          (method) => !method.startsWith("eth_send"),
        ),
      );
    }),
);

test(
  "changed exact policy bytes and changed code cannot produce a challenge",
  bounded,
  async (t) =>
    scenario(t, "policy-and-code-denials", async (f) => {
      const url = new URL(
          f.authority.release.policies["study-results"]!.documents.terms,
        ).pathname,
        original = f.authority.docs.get(url)!;
      f.authority.docs.set(url, original + "changed byte");
      const policy = await f.prepare("bad-policy");
      assert.equal(policy.status, 503);
      assert.equal(policy.value.walletRequest, undefined);
      f.authority.docs.set(url, original);
      f.authority.state.wrongCode = true;
      const code = await f.prepare("bad-code");
      assert.equal(code.status, 503);
      assert.equal(code.value.walletRequest, undefined);
      assert.ok(
        (await f.rows()).every(
          (r) => r.typed_json === null && r.signature === null,
        ),
      );
      assert.equal(f.operatorCalls.length, 0);
    }),
);

test(
  "an active fee successor cannot replace an original preparation or hide its later recovery",
  bounded,
  async (t) =>
    scenario(t, "retained-original-selection", async (f) => {
      const initial = await f.prepare();
      assert.equal(initial.status, 200);
      const c = parseCommand(initial.value.command);
      const replacement = structuredClone(f.authority.release);
      replacement.fee.cap = "2000000";
      await f.replaceActive(replacement);
      const retry = await f.prepare();
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.value.command, initial.value.command);
      assert.equal((await f.rows()).length, 1);
      // A fresh first signature is held after active replacement; original
      // preparation is still readable and never retargeted to the new fee.
      const submit = await f.submit({
        commandId: c.commandId,
        signature: await f.sign(c),
      });
      assert.equal(submit.status, 409);
      assert.equal((await f.call("commands/" + c.commandId)).status, 200);
    }),
);
