import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { communityRuntime } from "./community-runtime.ts";
import { hashText } from "../packages/community/common.ts";
import { karaokeLocalSessions } from "../harness/karaoke-local-session.ts";
import { sendPrivateKaraokeSocket, type PrivateKaraokeLease } from "../services/karaoke-socket-session.ts";
import type { Env } from "../services/runtime.ts";

const origin = "https://localhost:44743";
const communityId = ("0x" + "a1".repeat(32)) as `0x${string}`;
const wallet = "0x" + "b1".repeat(20);
for (const action of ["logout", "expiry"] as const) {
  test("the original socket session stops private egress on " + action, { timeout: 12000 }, async t => {
    const app = await communityRuntime();
    t.after(() => app.dispose());
    const db = app.db;
    await db.prepare("INSERT INTO application_identity VALUES (1,?,?)").bind(communityId, origin).run();
    await db.prepare("INSERT INTO community_accounts VALUES (?,?,?)").bind("a", "author", 0).run();
    await db.prepare("INSERT INTO credential_bindings VALUES (?,?,?,?,?,?)")
      .bind("binding", "a", "moss", 6343, wallet, 0).run();
    const raw = "7".repeat(64), oldHash = hashText(raw);
    async function put(raw: string, expiry: number) {
      await db.prepare("INSERT INTO community_sessions (session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES (?,?,?,?,?,?,?)")
        .bind(hashText(raw), communityId, origin, "a", "binding", "csrf", expiry).run();
    }
    await put(raw, Date.now() + 60000);
    const leases = karaokeLocalSessions(db, {origin, communityId});
    t.after(leases.close);
    const captured = await leases.capture("__Host-community_session=" + raw, () => undefined);
    assert.ok(captured);
    const lease: PrivateKaraokeLease = { id: captured.id, account: captured.account, expiresAt: captured.expiresAt };
    const sent: string[] = [], closes: number[] = [];
    const socket = { readyState: 1, send: (value: string) => sent.push(value), close: (code: number) => closes.push(code) } as unknown as WebSocket;
    const env = { KARAOKE_LOCAL_SESSION_GATE: { fetch: (url: string) => leases.fetch(new Request(url)) }} as unknown as Env;
    assert.equal(await sendPrivateKaraokeSocket(env, socket, lease, () => true, "before"), true);
    await put("8".repeat(64), Date.now() + 60000);
    if (action === "logout") await db.prepare("DELETE FROM community_sessions WHERE session_hash=?").bind(oldHash).run();
    else await db.prepare("UPDATE community_sessions SET expires_at=? WHERE session_hash=?").bind(Date.now(), oldHash).run();
    assert.equal(await sendPrivateKaraokeSocket(env, socket, lease, () => true, "after"), false);
    assert.deepEqual(sent, ["before"]);
    assert.deepEqual(closes, [4401]);
    const evidence = JSON.stringify({action, supportedSends:sent.length, refusedCode:closes[0]});
    t.diagnostic(JSON.stringify({evidence, sha256:createHash("sha256").update(evidence).digest("hex")}));
  });
}
