/** UNRUN. Local HTTP/session diagnostics of actual production ownership code.
 * No server, provider, physical capture or real private account acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDanceSessionOwner, selectedDanceCapability,
  type CommunityCapabilities,
} from "../src/live/api.ts";
import { createProductionDanceAccount } from "../src/dance/source/production-account.ts";
import { MAX_MEDIA_BYTES } from "../../../packages/community-media/validation.ts";

const communityId = "0x" + "1".repeat(64);
const authorId = "0x" + "2".repeat(64);
const identity = { communityId, authorId, csrf: "role-csrf-a" };
const capabilities: CommunityCapabilities = {
  schema: "pirate.community-capabilities/1", signIn: true, creatorConnection: false,
  upload: false, publication: false, policyVersion: "diagnostic-policy",
  dance: { version: "pirate.dance-capability/1", communityId,
    media: { version: "pirate.community-media/1", purpose: "private-review",
      policyVersion: "pirate.dance-private/1", maximumBytes: MAX_MEDIA_BYTES } },
};
test("normal mount policy is absent until a real community-bound source3 limit is supplied", () => {
  assert.equal(selectedDanceCapability(null, communityId), null);
  assert.equal(selectedDanceCapability({ ...capabilities, dance: undefined }, communityId), null);
  assert.equal(selectedDanceCapability(capabilities, "another-selected-community"), null);
  for (const maximumBytes of [0, -1, NaN, Infinity, 1.5])
    assert.equal(selectedDanceCapability({ ...capabilities, dance: {
      ...capabilities.dance!, media: { ...capabilities.dance!.media, maximumBytes },
    } }, communityId), null);
  assert.equal(selectedDanceCapability(capabilities, communityId)?.media.maximumBytes, MAX_MEDIA_BYTES);
});
test("session replacement masks every listener before successor publication; no public identity becomes accountId", () => {
  const owner = createDanceSessionOwner();
  owner.update(identity);
  const first = owner.current()!;
  const observations: unknown[] = [];
  owner.subscribe(() => { observations.push(owner.current()); throw Error("diagnostic listener"); });
  owner.subscribe(() => observations.push(owner.current()));
  assert.equal(owner.update({ ...identity }), false);
  assert.equal(owner.update({ ...identity, csrf: "role-csrf-b" }), true);
  assert.deepEqual(observations, [null, null]);
  assert.notEqual(owner.current()?.generation, first.generation);
  assert.equal("accountId" in owner.current()!, false);
  owner.clear(); assert.equal(owner.current(), null);
  owner.dispose(); assert.equal(owner.update(identity), false);
});
test("a reentrant teardown cannot publish a successor after disposal", () => {
  const owner = createDanceSessionOwner(); owner.update(identity);
  owner.subscribe(() => owner.dispose());
  owner.update({ ...identity, authorId: "0x" + "3".repeat(64) });
  assert.equal(owner.current(), null);
});
function ownerReply(accountId = "private_role_a", author = authorId) {
  return { schema: "pirate.community-profile-owner/1", communityId, accountId,
    profile: { schema: "pirate.community-profile/1", communityId, authorId: author,
      revision: 0, displayName: null, bio: null, avatarRef: null, coverRef: null },
    capabilities: { metadata: true, handles: false, publicMedia: false } };
}
test("actual production private lookup aborts/drops old response across normal owner generation", async () => {
  const session = createDanceSessionOwner(); session.update(identity);
  let release!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const account = createProductionDanceAccount({ session, fetcher: async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(resolve => { release = resolve; });
  } });
  const pending = account.account.load(new AbortController().signal);
  session.update({ ...identity, csrf: "role-csrf-b" });
  assert.equal(signal?.aborted, true);
  release(Response.json(ownerReply()));
  await assert.rejects(pending);
  assert.equal(account.account.current(), null);
  account.dispose(); session.dispose();
});
test("auth loss refuses an HTML body before private projection; a new owner must load its own private account", async () => {
  const session = createDanceSessionOwner(); session.update(identity);
  const account = createProductionDanceAccount({ session, fetcher: async () =>
    new Response("<html>denied</html>", { status: 401 }) });
  await assert.rejects(account.account.load(new AbortController().signal));
  assert.equal(account.account.current(), null);
  account.dispose();
  session.update({ ...identity, authorId: "0x" + "3".repeat(64), csrf: "role-csrf-b" });
  const next = createProductionDanceAccount({ session, fetcher: async () =>
    Response.json(ownerReply("private_role_b", "0x" + "3".repeat(64))) });
  const loaded = await next.account.load(new AbortController().signal);
  assert.equal(loaded?.accountId, "private_role_b");
  assert.notEqual(loaded?.accountId, session.current()?.authorId);
  next.dispose(); session.dispose();
});

// Fresh wire cases precede the capability/page implementation. JSON is the
// actual untrusted HTTP boundary; malformed inputs are not cast into authority.
const privateWire = () => JSON.parse(JSON.stringify({ ...capabilities,
  dance: { ...capabilities.dance, version: "pirate.dance-capability/2", captureProfile: "private-v2" },
}));
test("closed V2 selects only private-v2 and freezes its selected policy independently of response mutation", () => {
  const wire = privateWire(), selected = selectedDanceCapability(wire, communityId);
  assert.ok(selected);
  assert.equal(selected.version, "pirate.dance-capability/2");
  assert.equal(selected.captureProfile, "private-v2");
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.media));
  wire.dance.captureProfile = "public";
  wire.dance.media.maximumBytes = 1;
  assert.equal(selected.captureProfile, "private-v2");
  assert.equal(selected.media.maximumBytes, MAX_MEDIA_BYTES);
});
test("unknown, public and incomplete V2 capability combinations cannot fall back to V1", () => {
  for (const change of [
    (v: ReturnType<typeof privateWire>) => { delete v.dance.captureProfile; },
    (v: ReturnType<typeof privateWire>) => { v.dance.captureProfile = "public"; },
    (v: ReturnType<typeof privateWire>) => { v.dance.version = "pirate.dance-capability/3"; },
    (v: ReturnType<typeof privateWire>) => { v.dance.media.purpose = "public-feed"; },
    (v: ReturnType<typeof privateWire>) => { v.dance.media.policyVersion = "other"; },
    (v: ReturnType<typeof privateWire>) => { v.dance.media.maximumBytes = 0; },
    (v: ReturnType<typeof privateWire>) => { v.dance.media.maximumBytes = 1.5; },
    (v: ReturnType<typeof privateWire>) => { v.dance.communityId = "0x" + "3".repeat(64); },
    (v: ReturnType<typeof privateWire>) => { v.dance.publication = { kind: "public" }; },
    (v: ReturnType<typeof privateWire>) => { v.dance.media.authority = true; },
    (v: ReturnType<typeof privateWire>) => { v.dance.version = "pirate.dance-capability/1"; },
  ]) {
    const wire = privateWire(); change(wire);
    assert.equal(selectedDanceCapability(wire, communityId), null);
  }
  assert.equal(selectedDanceCapability({ ...capabilities, dance: undefined }, communityId), null);
  assert.equal(selectedDanceCapability(capabilities, communityId), capabilities.dance,
    "historical V1 policy and selection identity stay unchanged");
});
