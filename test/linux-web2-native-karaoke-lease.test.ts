import assert from "node:assert/strict";
import test from "node:test";
import { accountSession } from "../packages/community/accounts.ts";
import { bytes32 } from "../packages/community/common.ts";
import { NativeKaraokeLeaseRegistry, nativeKaraokeSessionRow } from "../services/linux-web2-karaoke-session-row.ts";
import { nativeProducerFixture } from "./application-native-producer-fixture.ts";

// Exercise the existing installed-session producer, native original row and
// SQLite-backed current-session read. The actual Workerd socket remains a gate.
test("native Karaoke leases hold original installed cookie authority across replacement and process loss", async t => {
  const fixture = await nativeProducerFixture();
  t.after(fixture.dispose);
  const context = { communityId: bytes32(fixture.profile.infrastructure.configuration.communityId),
    origin: fixture.profile.settings.origin };
  const read = (hash: string) => nativeKaraokeSessionRow(fixture.db,context,hash);
  const original = await fixture.login();
  const session = await accountSession(new Request(context.origin+"/api/session",{headers:{cookie:original.cookie}}),fixture.db,context);
  const row = await read(session.session_hash);
  assert(row && row.matchesAuth(session));
  const registry = new NativeKaraokeLeaseRegistry(read);
  const selected = {sessionHash:session.session_hash,fingerprint:row.fingerprint};
  const first = await registry.capture(selected);
  assert(first && await registry.current(first.id));
  assert.deepEqual(Object.keys(first).sort(),["account","expiresAt","id"]);
  assert.notEqual(first.id,session.session_hash.slice(2));
  const restarted = new NativeKaraokeLeaseRegistry(read);
  assert.equal(await restarted.current(first.id),false);
  assert((await read(session.session_hash))?.matchesAuth(session));

  const next = await fixture.login();
  const fresh = await accountSession(new Request(context.origin+"/api/session",{headers:{cookie:next.cookie}}),fixture.db,context);
  const replacement = await read(fresh.session_hash);
  assert(replacement && replacement.account===first.account);
  await fixture.db.prepare("DELETE FROM community_sessions WHERE session_hash=?").bind(session.session_hash).run();
  assert.equal(await registry.current(first.id),false);
  assert.equal(await registry.capture(selected),null);
  const second = await restarted.capture({sessionHash:fresh.session_hash,fingerprint:replacement.fingerprint});
  assert(second && second.id!==first.id && await restarted.current(second.id));
  await fixture.db.prepare("UPDATE community_sessions SET expires_at=? WHERE session_hash=?").bind(Date.now(),fresh.session_hash).run();
  assert.equal(await restarted.current(second.id),false);
  assert.equal(await restarted.current(first.id),false);
});
