/** UNRUN. Actual production adapters with explicitly simulated HTTP/session
 * replies; no Worker, browser, camera, native IDB or chain acceptance claimed. */
import test from "node:test";
import assert from "node:assert/strict";
import { createProductionDanceAccount, type DanceSessionProducer } from "../src/dance/source/production-account.ts";
import { createProductionDanceApi } from "../src/dance/source/production-api.ts";
import { createDancePlaybackPort } from "../src/dance/source/playback-adapter.ts";
import { createDancePrivateMediaPort } from "../src/dance/source/media-adapter.ts";
import { DanceClientError } from "../src/dance/client.ts";
import { createDanceClient } from "../src/dance/client.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import { captureFixture, consent, hash, mediaFixture, reviewFixture, scope } from "./dance-source-fixtures.ts";

const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function sessionSimulation() {
  let current: ReturnType<DanceSessionProducer["current"]> = {
    communityId: scope.communityId, generation: scope.sessionKey, csrf: "csrf-original", authorId: hash(95),
  };
  const listeners = new Set<() => void>();
  return { port: { current: () => current, subscribe: (cb: () => void) => {
    listeners.add(cb); return () => { listeners.delete(cb); };
  } }, switch() { current = { ...current!, generation: "session-next", csrf: "csrf-next" };
    for (const cb of [...listeners]) cb(); } };
}
const ownerReply = () => ({ schema: "pirate.community-profile-owner/1", communityId: scope.communityId,
  accountId: scope.accountId, profile: { schema: "pirate.community-profile/1", communityId: scope.communityId,
    authorId: hash(95), revision: 1, displayName: "Profile", bio: null, avatarRef: null, coverRef: null },
  capabilities: { metadata: true, publicMedia: false, handles: false } });
const pageReply = () => ({ version: "pirate.dance-catalogue/1", communityId: scope.communityId,
  accountId: scope.accountId, owner: false, consent, cursor: null,
  choices: [{ ...scope, title: "Dance 1", durationMs: 8013, playback: "ready", recordingAllowed: true }] });

test("actual private-profile decoder supplies accountId; public author never substitutes; old owner reply cannot publish", async () => {
  const session = sessionSimulation(), pending = deferred<Response>();
  let observedSignal: AbortSignal | null | undefined;
  const owner = createProductionDanceAccount({ session: session.port, fetcher: async (_url, init) => {
    observedSignal = init?.signal; return pending.promise;
  } });
  const load = owner.account.load(signal());
  session.switch();
  assert.equal(observedSignal?.aborted, true);
  pending.resolve(Response.json(ownerReply()));
  await assert.rejects(load);
  assert.equal(owner.account.current(), null);
  owner.dispose();
  const fresh = createProductionDanceAccount({ session: session.port, fetcher: async () => Response.json(ownerReply()) });
  const account = await fresh.account.load(signal());
  assert.equal(account?.accountId, scope.accountId);
  assert.notEqual(account?.accountId, ownerReply().profile.authorId);
  fresh.dispose(); assert.equal(fresh.account.current(), null);
  const mismatch = createProductionDanceAccount({ session: session.port, fetcher: async () =>
    Response.json({ ...ownerReply(), profile: { ...ownerReply().profile, authorId: hash(96) } }) });
  await assert.rejects(mismatch.account.load(signal()), /dance_owner_account_required/);
  assert.equal(mismatch.account.current(), null); mismatch.dispose();
});

test("catalogue binds account/song/revision; session loss aborts and rejects a late JSON body", async () => {
  const session = sessionSimulation();
  const owner = createProductionDanceAccount({ session: session.port, fetcher: async () => Response.json(ownerReply()) });
  await owner.account.load(signal());
  const body = deferred<unknown>();
  let sent: RequestInit | undefined;
  const api = createProductionDanceApi({ owner, fetcher: async (_url, init) => {
    sent = init; return { ok: true, status: 200, json: () => body.promise } as Response;
  } });
  const read = api.catalogue.options(scope, signal());
  // Let the real request reach its body await, then invalidate the generation.
  await Promise.resolve(); session.switch(); body.resolve(pageReply());
  await assert.rejects(read);
  assert.equal(sent?.signal?.aborted, true);
  assert.equal(new Headers(sent?.headers).get("x-dance-account"), scope.accountId);
  api.dispose(); owner.dispose();
});

test("known HTTP denial clears owner immediately without consuming a never-ending body", async () => {
  const session = sessionSimulation();
  const owner = createProductionDanceAccount({ session: session.port, fetcher: async () => Response.json(ownerReply()) });
  await owner.account.load(signal());
  let reads = 0, invalidations = 0;
  owner.account.subscribe(() => { invalidations++; });
  const api = createProductionDanceApi({ owner, fetcher: async () => ({ status: 403,
    json: () => { reads++; return new Promise(() => {}); } }) as Response });
  await assert.rejects(api.catalogue.options(scope, signal()), e => e instanceof DanceClientError && e.status === 403);
  assert.equal(reads, 0); assert.equal(invalidations, 1);
  assert.equal(owner.account.current(), null);
  assert.equal(await owner.account.load(signal()), null);
  api.dispose(); owner.dispose();
});

test("catalogue rejects changed immutable audio and latest rejects a different target", async () => {
  const session = sessionSimulation();
  const owner = createProductionDanceAccount({ session: session.port, fetcher: async () => Response.json(ownerReply()) });
  await owner.account.load(signal());
  let reply: unknown = { ...pageReply(), choices: [{ ...pageReply().choices[0], songKey: hash(99) }] };
  const api = createProductionDanceApi({ owner, fetcher: async () => Response.json(reply) });
  await assert.rejects(api.catalogue.options(scope, signal()), /dance_catalogue_binding_mismatch/);
  const r = reviewFixture(captureFixture(Date.now())); r.capture.songRevision++;
  reply = r;
  await assert.rejects(api.catalogue.latest(scope, signal()));
  api.dispose(); owner.dispose();
});

test("public audio has no invented expiry; exact bytes still required; private leases expire", async () => {
  const c = captureFixture(Date.now());
  const bytes = new Blob(["canonical guide bytes"]);
  c.audioSha256 = "0x" + Buffer.from(await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())).toString("hex");
  let downloads = 0;
  const grant = { communityId: c.communityId, songKey: c.songKey, songRevision: c.songRevision,
    audioSha256: c.audioSha256, playback_url: "https://community.invalid/api/public/posts/" + c.songKey + "/audio" };
  const publicPort = createDancePlaybackPort({ songGrant: async () => ({ ...grant, access: "public" }),
    reference: async () => { throw Error("reference not supplied in this simulation"); },
    fetcher: async () => { downloads++; return new Response(bytes); } });
  const source = await publicPort.guide(c, signal());
  assert.equal(source.expiresAtSeconds, undefined);
  assert.equal(await source.blob.text(), "canonical guide bytes"); source.release(); source.release();
  const expired = createDancePlaybackPort({ songGrant: async () => ({ ...grant, expires_at: Math.floor(Date.now() / 1000) - 1 }),
    reference: publicPort.reference, fetcher: async () => { downloads++; return new Response(bytes); } });
  await assert.rejects(expired.guide(c, signal())); assert.equal(downloads, 1);
  const changed = { ...c, audioSha256: hash(99) };
  await assert.rejects(publicPort.guide(changed, signal()));
});

test("guide late lifetime loss releases owned Blob URL; private ready media cannot outlive its lease", async () => {
  const c = captureFixture(Date.now()), bytes = new Blob(["guide"]);
  c.audioSha256 = "0x" + Buffer.from(await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())).toString("hex");
  let current = true;
  const playback = createDancePlaybackPort({ isCurrent: () => current,
    songGrant: async () => ({ communityId: c.communityId, songKey: c.songKey, songRevision: c.songRevision,
      audioSha256: c.audioSha256, access: "public", playback_url: "https://community.invalid/audio" }),
    reference: async () => { throw Error("no reference in simulation"); },
    fetcher: async () => { current = false; return new Response(bytes); } });
  let released = 0;
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = url => { released++; revoke(url); };
  try { await assert.rejects(playback.guide(c, signal())); assert.equal(released, 1); }
  finally { URL.revokeObjectURL = revoke; }
  const r = reviewFixture(c), status = mediaFixture(c);
  status.playbackUrl = `/api/media/${r.receipt.mediaId}/playback`;
  status.id = r.receipt.mediaId;
  status.ready!.id = r.receipt.mediaId;
  status.ready!.expiresAt = Date.now() - 1;
  const privatePort = createDancePrivateMediaPort({ scope: { ...scope, audioSha256: c.audioSha256 },
    currentScope: () => ({ ...scope, audioSha256: c.audioSha256 }), csrf: () => "csrf",
    maximumBytes: 1024, fetcher: async () => Response.json(status) });
  await assert.rejects(privatePort.playback(r, signal()), e => e instanceof DanceClientError && e.status === 410);
});

test("production account loss retains actual journal UUID/body; same account reload observes uncertainty without automatic POST", async () => {
  const session = sessionSimulation();
  const owner = createProductionDanceAccount({ session: session.port, fetcher: async () => Response.json(ownerReply()) });
  await owner.account.load(signal());
  const storage = simulatedCommandStorage();
  let sends = 0;
  const client = createDanceClient({ communityId: scope.communityId, accountId: scope.accountId,
    csrf: "csrf-original", journal: storage.journal(), isCurrent: () => !!owner.account.current(),
    fetcher: async () => { sends++; throw Error("simulated response lost after dispatch"); } });
  const command = await client.prepareCapture!("immutable-target", scope.songKey, scope.offerId, scope.reference!.id,
    { accepted: true, version: consent.version, termsHash: consent.termsHash, publicityPolicyHash: consent.publicityPolicyHash });
  await assert.rejects(client.dispatchPrepared!(command, signal()));
  const retained = await client.command!(command.commandId);
  session.switch(); client.dispose();
  assert.equal(retained?.requestJson, command.requestJson);
  const reload = createDanceClient({ communityId: scope.communityId, accountId: scope.accountId,
    csrf: "csrf-next", journal: storage.journal(), isCurrent: () => true,
    fetcher: async () => { sends++; throw Error("No automatic replacement allowed"); } });
  assert.equal((await reload.retained!())?.commandId, command.commandId);
  assert.equal((await reload.retained!())?.requestJson, command.requestJson);
  assert.equal(sends, 1);
  reload.dispose(); owner.dispose();
});
