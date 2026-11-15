import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommunityJoinView, MemberNameView } from "../api-contract.ts";
import {
  acceptedJoin, canonicalMemberLabel, createCommunityMembership,
  MemberActionError, memberNameRecoveryCopy, type MemberOwner, type PreparedName,
} from "./community-membership.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const secondWallet = "0x2222222222222222222222222222222222222222";
const originalId = ("0x" + "31".repeat(32)) as `0x${string}`;
const originalDigest = ("0x" + "41".repeat(32)) as `0x${string}`;
const joined: CommunityJoinView = {
  schema: "pirate.community-join/1", ownerScope: "fixture-owner-scope", revision: 2,
  state: "accepted", receipt: { joinId: "fixture-join", acceptedAtMs: 1000 },
};
const notJoined: CommunityJoinView = {
  schema: "pirate.community-join/1", ownerScope: "fixture-owner-scope", revision: 1,
  state: "not_joined",
};
const idle: MemberNameView = {
  schema: "pirate.member-name/1", ownerScope: "fixture-owner-scope", revision: 1,
  recipient: wallet, tld: "fixture", state: "idle", claim: null,
};
const prepared: PreparedName = {
  ...idle, revision: 2, state: "awaiting_consent",
  claim: { requestId: originalId, planDigest: originalDigest, label: "role-member", name: "role-member.fixture" },
  consent: {
    digest: originalDigest, expiresAtMs: 9000,
    typedData: {
      domain: { chainId: 6343, name: "Fixture only", version: "1", verifyingContract: secondWallet },
      types: { ClaimAcceptance: [{ name: "fixture", type: "string" }] },
      primaryType: "ClaimAcceptance", message: { fixture: "synthetic; never signed" },
    },
  },
  terms: { initialPriceAtomic: "0", initialTermDays: 365,
    gas: { payerAddress: secondWallet, maxTotalWei: "1000" },
    annualRenewal: { token: secondWallet, amountAtomic: "10" } },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(handler: (path: string, init: RequestInit) => Promise<Response> | Response,
  signer?: (value: PreparedName, guard: () => void) => Promise<string>) {
  let owner: MemberOwner | null = { key: "fixture-session-a", csrf: "fixture-csrf", wallet };
  let keys = 0, time = 2000, signed = 0;
  const calls: { path: string; init: RequestInit }[] = [];
  const auth: (number | string)[] = [];
  const fixtureFetch: typeof fetch = async (input, init = {}) => {
    const path = String(input), method = init.method ?? "GET";
    calls.push({ path, init });
    // Exact reviewed producer routes; former /current is not an alias.
    const original = /^\/api\/member-name\/claims\/0x[0-9a-f]{64}(\/(consent|reconcile))?$/.exec(path);
    const supported = (path === "/api/community/join" && ["GET", "POST"].includes(method)) ||
      (path === "/api/member-name" && method === "GET") ||
      (path === "/api/member-name/claims" && method === "POST") ||
      (original && method === (original[1] ? "POST" : "GET"));
    return supported ? handler(path, init) : json({ error: "member_route_not_found" }, 404);
  };
  const controller = createCommunityMembership({
    owner: () => owner, newKey: () => "fixture-idempotency-" + ++keys, now: () => time,
    fetch: fixtureFetch,
    sign: async (value, guard) => {
      signed++; return signer ? signer(value, guard) : "0x" + "11".repeat(65);
    },
    authLost: status => { auth.push(status); owner = null; },
    changed: () => {},
  });
  controller.sync();
  return {
    controller, calls, auth, fixtureFetch, signed: () => signed, keys: () => keys,
    setOwner: (value: MemberOwner | null) => { owner = value; controller.sync(); },
    advance: (ms: number) => { time += ms; },
  };
}

test("Join POST ACK alone never makes Joined; only accepted observational readback does", async () => {
  let committed = false, permitReadback = false;
  const h = harness((path, init) => {
    assert.equal(path, "/api/community/join");
    if (init.method === "POST") { committed = true; return json(joined); }
    return json(committed && permitReadback ? joined : notJoined);
  });
  await h.controller.join();
  assert.equal(acceptedJoin(h.controller.state()), false);
  permitReadback = true;
  await h.controller.loadJoin();
  assert.equal(acceptedJoin(h.controller.state()), true);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  const write = h.calls.find(call => call.init.method === "POST")!;
  assert.deepEqual(JSON.parse(String(write.init.body)), { idempotencyKey: "fixture-idempotency-1" });
  assert.equal(write.init.credentials, "same-origin");
  assert.equal(new Headers(write.init.headers).get("x-csrf-token"), "fixture-csrf");
});

test("lost Join ACK retains the one command and recovers through GET; login is not Join", async () => {
  let committed = false;
  const h = harness((_path, init) => {
    if (init.method === "POST") { committed = true; throw Error("fixture lost ACK"); }
    return json(committed ? joined : notJoined);
  });
  await h.controller.loadJoin();
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  assert.equal(acceptedJoin(h.controller.state()), false);
  await h.controller.join();
  await h.controller.join();
  assert.equal(acceptedJoin(h.controller.state()), true);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(h.keys(), 1);
});

test("lost prepare ACK locates the original request; dismissal/reopening never reissues", async () => {
  let original = false;
  const h = harness((path, init) => {
    if (path === "/api/community/join") return json(joined);
    if (path === "/api/member-name/claims" && init.method === "POST") {
      original = true; throw Error("fixture lost prepare ACK");
    }
    return json(original ? prepared : idle);
  });
  await h.controller.loadJoin(); await h.controller.openName();
  await h.controller.prepareName("role-member");
  assert.equal(h.controller.state().name?.state, "awaiting_consent");
  h.controller.dismissName();
  assert.equal(acceptedJoin(h.controller.state()), true);
  assert.equal(h.controller.state().nameOpen, false);
  await h.controller.openName();
  await h.controller.prepareName("different-member");
  const writes = h.calls.filter(call => call.path === "/api/member-name/claims" && call.init.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(String(writes[0]!.init.body)), {
    idempotencyKey: "fixture-idempotency-1", label: "role-member",
  });
  assert.ok(h.calls.some(call => call.path === "/api/member-name/claims/" + originalId));
  assert.equal(h.signed(), 0);
});

test("a delayed idle lookup after lost prepare ACK never authorizes a replacement", async () => {
  const h = harness((path, init) => {
    if (path === "/api/community/join") return json(joined);
    if (init.method === "POST") throw Error("fixture unknown write outcome");
    return json(idle);
  });
  await h.controller.loadJoin(); await h.controller.openName();
  await h.controller.prepareName("role-member");
  assert.equal(h.controller.state().nameUncertain, true);
  h.controller.dismissName(); await h.controller.openName();
  await h.controller.prepareName("other-role");
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(h.keys(), 1);
});

test("observational current read after reload restores original without a prepare or signature", async () => {
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared));
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.controller.state().name?.state, "awaiting_consent");
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  assert.equal(h.signed(), 0);
});

test("no consent submission before explicit consent; stale wallet completion after dismissal is dropped", async () => {
  const signature = deferred<string>();
  const entered = deferred<void>();
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared),
    async (_value, guard) => { entered.resolve(); const result = await signature.promise; guard(); return result; });
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.signed(), 0);
  const signing = h.controller.consent(); await entered.promise;
  h.controller.dismissName(); signature.resolve("0x" + "11".repeat(65));
  await signing;
  assert.equal(h.calls.filter(call => call.path.endsWith("/consent")).length, 0);
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("account/CSRF/scope changes mask owner state and discard late name results", async () => {
  const read = deferred<Response>();
  const h = harness(path => path === "/api/community/join" ? json(joined) : read.promise);
  await h.controller.loadJoin();
  const loading = h.controller.openName();
  h.setOwner({ key: "fixture-session-b", csrf: "fixture-csrf-b", wallet: secondWallet });
  assert.equal(h.controller.state().join, null);
  assert.equal(h.controller.state().name, null);
  read.resolve(json(prepared));
  await loading;
  assert.equal(h.controller.state().name, null);
  assert.equal(h.controller.state().ownerKey, "fixture-session-b");
  h.setOwner({ key: "fixture-session-a-refreshed", csrf: "fixture-csrf-a-refreshed", wallet });
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.controller.state().name?.state, "awaiting_consent");
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  assert.equal(h.keys(), 0);
});

test("account switch during wallet await cannot consent under either successor account", async () => {
  const signature = deferred<string>(), entered = deferred<void>();
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared),
    async (_value, guard) => { entered.resolve(); const result = await signature.promise; guard(); return result; });
  await h.controller.loadJoin(); await h.controller.openName();
  const signing = h.controller.consent(); await entered.promise;
  h.setOwner({ key: "fixture-session-b", csrf: "new-csrf", wallet: secondWallet });
  signature.resolve("0x" + "11".repeat(65)); await signing;
  assert.equal(h.calls.filter(call => call.path.endsWith("/consent")).length, 0);
  assert.equal(h.controller.state().join, null);
});

test("unsupported wallet remains distinct from server issuer unavailable, without losing Join", async () => {
  let serverBlocked = false;
  const h = harness(path => json(path === "/api/community/join" ? joined :
    serverBlocked ? { ...idle, state: "blocked", reason: "issuer_unavailable",
      correction: "Fixture issuer is unavailable. Check again later." } : prepared,
    path !== "/api/community/join" && serverBlocked ? 503 : 200),
    async () => { throw new MemberActionError("wallet_unsupported", "Fixture wallet cannot sign this claim."); });
  await h.controller.loadJoin(); await h.controller.openName(); await h.controller.consent();
  assert.equal(h.controller.state().error, "Fixture wallet cannot sign this claim.");
  assert.equal(h.calls.filter(call => call.path.endsWith("/consent")).length, 0);
  assert.equal(acceptedJoin(h.controller.state()), true);
  // A separate original server scope is used for the issuer-unavailable read.
  serverBlocked = true;
  h.setOwner({ key: "fixture-refreshed-session", csrf: "fixture-refreshed-csrf", wallet });
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.controller.state().name?.state, "blocked");
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("queued/unknown respect the server retry delay and never sign or prepare again", async () => {
  const queued: MemberNameView = { ...idle, state: "queued", revision: 2,
    claim: prepared.claim, terms: prepared.terms, retryAfterMs: 500 };
  const h = harness(path => json(path === "/api/community/join" ? joined : queued));
  await h.controller.loadJoin(); await h.controller.openName();
  const before = h.calls.length;
  h.controller.dismissName(); await h.controller.openName();
  assert.equal(h.controller.state().name?.state, "queued");
  assert.equal(acceptedJoin(h.controller.state()), true);
  await h.controller.prepareName("role-member"); await h.controller.consent();
  await h.controller.reconcile();
  assert.equal(h.calls.length, before);
  h.advance(500); await h.controller.checkName();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.signed(), 0);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
});

test("HTML/empty 401 and 403 synchronously mask prior private facts before body parsing", async () => {
  for (const status of [401, 403] as const) {
    let lost = false;
    const h = harness(path => {
      if (!lost) return json(path === "/api/community/join" ? joined : idle);
      const response = new Response(status === 401 ? "<html>expired</html>" : null, { status });
      response.json = () => { throw Error("must not parse an auth-loss body"); };
      return response;
    });
    await h.controller.loadJoin(); await h.controller.openName();
    lost = true; await h.controller.checkName();
    assert.equal(h.controller.state().join, null);
    assert.equal(h.controller.state().name, null);
    assert.deepEqual(h.auth, [status]);
  }
});

test("consumed receipt and unavailable usability never infer Join; expired naming preserves Join", async () => {
  const name: MemberNameView = { ...idle, state: "consumed", revision: 2,
    claim: prepared.claim, terms: prepared.terms,
    receipt: { transactionHash: originalId, tokenId: "1", generation: "1", expiryMs: 9000,
      blockNumber: "2", blockHash: originalDigest }, usability: "not_usable" };
  const h = harness(path => json(path === "/api/community/join" ? joined : name));
  assert.equal(acceptedJoin(h.controller.state()), false);
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(acceptedJoin(h.controller.state()), true);
  const expired: MemberNameView = { ...idle, state: "expired_unconsumed", revision: 3,
    claim: prepared.claim, reason: "request_conflict", correction: "Fixture original consent expired." };
  const other = harness(path => json(path === "/api/community/join" ? joined : expired));
  await other.controller.loadJoin(); await other.controller.openName();
  assert.equal(acceptedJoin(other.controller.state()), true);
  assert.equal(other.controller.state().name?.state, "expired_unconsumed");
  assert.equal(h.controller.state().name?.state, "consumed");
});

test("cross-owner response masks prior private facts and never installs another owner's data", async () => {
  let foreign = false;
  const h = harness(path => json(path === "/api/community/join" ? joined :
    foreign ? { ...prepared, ownerScope: "another-owner" } : idle));
  await h.controller.loadJoin(); await h.controller.openName();
  foreign = true; await h.controller.checkName();
  assert.equal(h.controller.state().name, null);
  assert.equal(h.controller.state().join, null);
  assert.deepEqual(h.auth, ["scope_changed"]);
  assert.equal(h.signed(), 0);
});

test("canonical input bounds do not silently rewrite a label or create writes", () => {
  for (const value of ["short", "UPPERCASE", "role name", "-role-member", "a".repeat(64), "rôle-member"])
    assert.equal(canonicalMemberLabel(value), false);
  assert.equal(canonicalMemberLabel("role-123"), true);
  assert.equal(canonicalMemberLabel("a".repeat(63)), true);
  assert.equal(canonicalMemberLabel("role--member"), true);
  assert.equal(canonicalMemberLabel("xn--member"), false);
});

test("explicit Join waits for the existing session read and concurrent clicks produce one command", async () => {
  const firstRead = deferred<Response>();
  let reads = 0, committed = false;
  const h = harness((_path, init) => {
    if (init.method === "POST") { committed = true; return json(joined); }
    if (++reads === 1) return firstRead.promise;
    return json(committed ? joined : notJoined);
  });
  const loading = h.controller.loadJoin();
  const click = h.controller.join(), repeatClick = h.controller.join();
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  firstRead.resolve(json(notJoined));
  await Promise.all([loading, click, repeatClick]);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(h.keys(), 1);
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("explicit consent submits only original plan/signature and lost ACK observes that original", async () => {
  let submitted = false;
  const queued: MemberNameView = { ...idle, state: "queued", revision: 3,
    claim: prepared.claim, terms: prepared.terms, retryAfterMs: 500 };
  const h = harness((path, init) => {
    if (path === "/api/community/join") return json(joined);
    if (path.endsWith("/consent")) { submitted = true; throw Error("fixture lost consent ACK"); }
    return json(submitted ? queued : prepared);
  });
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.signed(), 0);
  await h.controller.consent();
  const consent = h.calls.filter(call => call.path.endsWith("/consent"));
  assert.equal(consent.length, 1);
  assert.equal(consent[0]!.path, "/api/member-name/claims/" + originalId + "/consent");
  assert.deepEqual(JSON.parse(String(consent[0]!.init.body)), {
    planDigest: originalDigest, recipientSignature: "0x" + "11".repeat(65),
  });
  assert.equal(h.controller.state().name?.state, "queued");
  assert.equal(h.keys(), 0);
  await h.controller.consent();
  assert.equal(h.signed(), 1);
});

test("rate-limited original reads never authorize new consent or replacement prepare", async () => {
  let limited = false;
  const h = harness(path => path === "/api/community/join" ? json(joined) :
    limited ? new Response("<html>rate limited</html>", { status: 429 }) : json(prepared));
  await h.controller.loadJoin(); await h.controller.openName();
  limited = true; await h.controller.checkName();
  assert.equal(h.controller.state().nameUncertain, true);
  await h.controller.consent(); await h.controller.prepareName("another-role");
  assert.equal(h.signed(), 0);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("expired original consent never opens wallet or submits and remains observable", async () => {
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared));
  await h.controller.loadJoin(); await h.controller.openName();
  h.advance(7001); await h.controller.consent();
  assert.equal(h.signed(), 0);
  assert.equal(h.calls.filter(call => call.path.endsWith("/consent")).length, 0);
  assert.equal(h.controller.state().nameUncertain, true);
  assert.match(h.controller.state().error!, /original consent expired/i);
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("an explicit Join retry after definitive not_joined retains exactly the original key/body", async () => {
  let writes = 0;
  const h = harness((_path, init) => {
    if (init.method === "POST") { writes++; if (writes === 1) throw Error("fixture request never arrived"); }
    return json(writes >= 2 ? joined : notJoined);
  });
  await h.controller.join();
  assert.equal(acceptedJoin(h.controller.state()), false);
  await h.controller.join();
  const commands = h.calls.filter(call => call.init.method === "POST");
  assert.equal(commands.length, 2);
  assert.equal(commands[0]!.init.body, commands[1]!.init.body);
  assert.equal(h.keys(), 1);
  assert.equal(acceptedJoin(h.controller.state()), true);
});

test("unmount permanently drops late wallet work without reviving an authenticated owner", async () => {
  const signature = deferred<string>(), entered = deferred<void>();
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared),
    async (_value, guard) => { entered.resolve(); const result = await signature.promise; guard(); return result; });
  await h.controller.loadJoin(); await h.controller.openName();
  const signing = h.controller.consent(); await entered.promise;
  h.controller.dispose(); signature.resolve("0x" + "11".repeat(65)); await signing;
  assert.equal(h.controller.state().ownerKey, null);
  assert.equal(h.controller.state().name, null);
  assert.equal(h.calls.filter(call => call.path.endsWith("/consent")).length, 0);
});

test("current restoration uses GET /api/member-name; the former /current path is a real 404", async () => {
  const h = harness(path => json(path === "/api/community/join" ? joined : prepared));
  await h.controller.loadJoin(); await h.controller.openName();
  assert.equal(h.controller.state().name?.state, "awaiting_consent");
  assert.deepEqual(h.calls.map(call => [call.path, call.init.method]), [
    ["/api/community/join", "GET"], ["/api/member-name", "GET"],
  ]);
  const missing = await h.fixtureFetch("/api/member-name/current", { method: "GET" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "member_route_not_found" });
  assert.equal(h.signed(), 0);
  assert.equal(h.keys(), 0);
});

test("real 503 issuer refusal from prepare is retained without an idle read overwriting it", async () => {
  const refusal: MemberNameView = { ...idle, revision: 2, state: "blocked",
    reason: "issuer_unavailable", correction: "Fixture issuer unavailable; original custody retained." };
  let currentReads = 0;
  const h = harness((path, init) => {
    if (path === "/api/community/join") return json(joined);
    if (path === "/api/member-name") { currentReads++; return json(idle); }
    assert.equal(path, "/api/member-name/claims");
    assert.equal(init.method, "POST");
    return json(refusal, 503);
  });
  await h.controller.loadJoin(); await h.controller.openName();
  await h.controller.prepareName("role-member");
  assert.deepEqual(h.controller.state().name, refusal);
  assert.equal(currentReads, 1);
  assert.equal(acceptedJoin(h.controller.state()), true);
  assert.equal(h.controller.state().error, null);
  assert.equal(h.signed(), 0);
  await h.controller.prepareName("different-role");
  assert.equal(h.calls.filter(call => call.path === "/api/member-name/claims").length, 1);
  assert.equal(h.keys(), 1);
});

test("real 503 issuer and 422 recipient consent refusals retain distinct original DTOs", async () => {
  for (const [status, reason, correction] of [
    [503, "issuer_unavailable", "Fixture issuer unavailable; saved consent retained."],
    [422, "recipient_unsupported", "Fixture recipient cannot supply the required acceptance."],
  ] as const) {
    const refusal: MemberNameView = { ...idle, revision: 3, state: "blocked",
      claim: prepared.claim, reason, correction };
    let currentReads = 0, statuses: number[] = [];
    const h = harness((path, init) => {
      if (path === "/api/community/join") return json(joined);
      if (path === "/api/member-name") { currentReads++; return json(prepared); }
      assert.equal(path, "/api/member-name/claims/" + originalId + "/consent");
      assert.equal(init.method, "POST");
      statuses.push(status);
      return json(refusal, status);
    });
    await h.controller.loadJoin(); await h.controller.openName();
    await h.controller.consent();
    assert.deepEqual(statuses, [status]);
    assert.deepEqual(h.controller.state().name, refusal);
    assert.equal(currentReads, 1);
    assert.equal(acceptedJoin(h.controller.state()), true);
    assert.equal(h.controller.state().error, null);
    const command = h.calls.find(call => call.path.endsWith("/consent"))!;
    assert.deepEqual(JSON.parse(String(command.init.body)), {
      planDigest: originalDigest, recipientSignature: "0x" + "11".repeat(65),
    });
    await h.controller.consent();
    assert.equal(h.signed(), 1);
    assert.equal(h.calls.filter(call => call.path === "/api/member-name/claims").length, 0);
  }
});

test("non-2xx refusal bodies cannot install another owner, recipient, malformed DTO or consumed fact", async () => {
  const refusal: MemberNameView = { ...idle, state: "blocked", revision: 2,
    reason: "issuer_unavailable", correction: "Fixture refusal." };
  const consumed: MemberNameView = { ...idle, state: "consumed", revision: 2,
    claim: prepared.claim, terms: prepared.terms,
    receipt: { transactionHash: originalId, tokenId: "1", generation: "1",
      expiryMs: 9000, blockNumber: "2", blockHash: originalDigest }, usability: "usable" };
  for (const [body, scopeLost] of [
    [{ ...refusal, ownerScope: "foreign-owner" }, true],
    [{ ...refusal, recipient: secondWallet }, false],
    [{ ...refusal, revision: "not-a-revision" }, false],
    [consumed, false],
  ] as const) {
    let refuse = false;
    const h = harness(path => path === "/api/community/join" ? json(joined) :
      refuse ? json(body, 503) : json(idle));
    await h.controller.loadJoin(); await h.controller.openName();
    refuse = true; await h.controller.checkName();
    if (scopeLost) {
      assert.equal(h.controller.state().name, null);
      assert.equal(h.controller.state().join, null);
      assert.deepEqual(h.auth, ["scope_changed"]);
    } else {
      assert.equal(h.controller.state().name?.state, "idle");
      assert.equal(h.controller.state().nameUncertain, true);
      assert.equal(acceptedJoin(h.controller.state()), true);
    }
    assert.equal(h.signed(), 0);
    assert.equal(h.calls.filter(call => call.init.method === "POST").length, 0);
  }
});

test("a valid-looking refusal on 401/403 is masked before parsing, never retained as owner data", async () => {
  for (const status of [401, 403] as const) {
    let lost = false, parsed = false;
    const h = harness(path => {
      if (!lost) return json(path === "/api/community/join" ? joined : idle);
      const response = json({ ...idle, state: "blocked", reason: "issuer_unavailable",
        correction: "This authenticated-looking body must not be parsed." }, status);
      response.json = async () => { parsed = true; throw Error("auth body must not be read"); };
      return response;
    });
    await h.controller.loadJoin(); await h.controller.openName();
    lost = true; await h.controller.checkName();
    assert.equal(parsed, false);
    assert.equal(h.controller.state().name, null);
    assert.equal(h.controller.state().join, null);
    assert.deepEqual(h.auth, [status]);
  }
});

test("unknown/expired recovery uses only the original operation and ignores replacement-prompt copy", async () => {
  const unknown: MemberNameView = { ...idle, state: "unknown", revision: 3,
    claim: prepared.claim, terms: prepared.terms, retryAfterMs: 0 };
  const expired: MemberNameView = { ...idle, state: "expired_unconsumed", revision: 3,
    claim: prepared.claim, reason: "request_conflict",
    correction: "Press Get name to start again." }; // Deliberately unsafe fixture copy.
  for (const view of [unknown, expired]) {
    const h = harness((path, init) => {
      if (path === "/api/community/join") return json(joined);
      if (init.method === "POST") {
        assert.equal(path, "/api/member-name/claims/" + originalId + "/reconcile");
        assert.deepEqual(JSON.parse(String(init.body)), { planDigest: originalDigest });
      }
      return json(view);
    });
    await h.controller.loadJoin(); await h.controller.openName();
    await h.controller.prepareName("different-role"); await h.controller.consent();
    await h.controller.reconcile();
    h.controller.dismissName(); await h.controller.openName();
    await h.controller.prepareName("another-role");
    assert.equal(acceptedJoin(h.controller.state()), true);
    assert.equal(h.controller.state().name?.claim?.requestId, originalId);
    assert.equal(h.calls.filter(call => call.path === "/api/member-name/claims").length, 0);
    assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
    assert.equal(h.keys(), 0);
    assert.equal(h.signed(), 0);
    const copy = memberNameRecoveryCopy(h.controller.state().name, h.controller.state().nameUncertain)!;
    assert.match(copy, /original/);
    assert.match(copy, /No replacement is authorized/);
    assert.doesNotMatch(copy, /Get name|start again|joined/i);
  }
});
