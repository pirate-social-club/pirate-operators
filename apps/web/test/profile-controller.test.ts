// UNRUN: real client/controller boundary; no Solid/browser/server is started.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createProfileController,
  type ProfileIdentity,
} from "../src/shell/profiles/controller.ts";
import {
  createProfileClient,
  ProfileRequestError,
  type ProfileClient,
} from "../src/shell/profiles/client.ts";
import type {
  OwnerProfile,
  ProfileMutation,
  ProfileMutationReceipt,
} from "../../../packages/community-profile/contracts.ts";

const communityId = "0x" + "1".repeat(64),
  authorId = "0x" + "2".repeat(64);
const owner: OwnerProfile = {
  schema: "pirate.community-profile-owner/1",
  communityId,
  accountId: "private-fixture-account",
  profile: {
    schema: "pirate.community-profile/1",
    communityId,
    authorId,
    revision: 0,
    displayName: null,
    bio: null,
    avatarRef: null,
    coverRef: null,
  },
  capabilities: { metadata: true, publicMedia: false, handles: false },
};
function clientStub(): ProfileClient {
  return {
    owner: async () => owner,
    public: async () => owner.profile,
    authors: async () => [owner.profile],
    activity: async () => ({
      schema: "pirate.community-profile-activity/1",
      communityId,
      authorId,
      profile: owner.profile,
      items: [],
      nextCursor: null,
      window: "current-public-catalogue",
    }),
    save: async () => {
      throw new Error("not supplied");
    },
    receipt: async () => null,
  };
}
test("late private owner data from a prior account is aborted and discarded", async () => {
  let identity: ProfileIdentity | null = { authorId, csrf: "a", scopeKey: "a" };
  let resolve!: (value: OwnerProfile) => void;
  let captured: AbortSignal | undefined;
  const client = clientStub();
  client.owner = (signal) => {
    captured = signal;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const controller = createProfileController({
    client,
    identity: () => identity,
    changed: () => {},
  });
  const loading = controller.load();
  identity = { authorId: "0x" + "3".repeat(64), csrf: "b", scopeKey: "b" };
  controller.sync();
  assert.equal(captured?.aborted, true);
  resolve(owner);
  await loading;
  assert.notEqual(controller.state.view.kind, "ready");
  assert.equal(controller.hasPending, false);
  controller.dispose();
});
test("unknown save is reconciled by exact receipt; no new command or second save", async () => {
  const client = clientStub();
  let saves = 0,
    committed: ProfileMutationReceipt | null = null;
  client.save = async (body) => {
    saves++;
    committed = {
      schema: "pirate.community-profile-mutation/1",
      mutationId: body.mutationId,
      profile: { ...owner.profile, revision: 1, displayName: body.displayName },
    };
    throw new ProfileRequestError(0, "lost response");
  };
  client.receipt = async () => committed;
  const controller = createProfileController({
    client,
    identity: () => ({ authorId, csrf: "a", scopeKey: "a" }),
    changed: () => {},
  });
  await controller.load();
  await controller.save({
    displayName: "Fixture profile",
    bio: null,
    avatarRef: null,
    coverRef: null,
  });
  assert.equal(controller.state.mutation, "unknown");
  assert.equal(controller.hasPending, true);
  await controller.retry();
  assert.equal(saves, 1);
  assert.equal(controller.hasPending, false);
  assert.equal(controller.state.mutation, "idle");
  assert.equal(
    controller.state.view.kind === "ready" &&
      controller.state.view.owner.profile.revision,
    1,
  );
  controller.dispose();
});
test("401 is anonymous; unavailable/ambiguous authority is retryable, never another identity", async () => {
  const client = clientStub();
  const controller = createProfileController({
    client,
    identity: () => null,
    changed: () => {},
  });
  client.owner = async () => {
    throw new ProfileRequestError(401, "session_required");
  };
  await controller.load();
  assert.equal(controller.state.view.kind, "anonymous");
  client.owner = async () => {
    throw new ProfileRequestError(503, "unavailable");
  };
  await controller.load();
  assert.equal(controller.state.view.kind, "unavailable");
  client.owner = async () => owner;
  await controller.load();
  assert.equal(controller.state.view.kind, "unavailable");
  controller.dispose();
});
test("client uses same-origin cookies and rejects mismatched public authority or untrusted media", async () => {
  let request: RequestInit | undefined;
  const client = createProfileClient(communityId, (async (
    _url: any,
    options: any,
  ) => {
    request = options;
    return Response.json({ ...owner.profile, authorId: "0x" + "3".repeat(64) });
  }) as typeof fetch);
  await assert.rejects(client.public(authorId, new AbortController().signal));
  assert.equal(request?.credentials, "same-origin");
  assert.equal(request?.cache, "no-store");
});

test("a new session for the same author masks old owner state and drops retained commands", async () => {
  let identity = { authorId, csrf: "first", scopeKey: "first" };
  const controller = createProfileController({
    client: clientStub(),
    identity: () => identity,
    changed: () => {},
  });
  await controller.load();
  assert.equal(controller.state.view.kind, "ready");
  identity = { authorId, csrf: "second", scopeKey: "second" };
  assert.equal(controller.state.view.kind, "loading");
  controller.sync();
  assert.equal(controller.hasPending, false);
  controller.dispose();
});

test("authentication loss after an unknown save retains its original recovery identity", async () => {
  const client = clientStub();
  let reads = 0,
    saves = 0;
  client.receipt = async () => {
    if (reads++ > 0) throw new ProfileRequestError(401, "session_required");
    return null;
  };
  client.save = async () => {
    saves++;
    throw new ProfileRequestError(0, "unknown response");
  };
  const controller = createProfileController({
    client,
    identity: () => ({ authorId, csrf: "a", scopeKey: "a" }),
    changed: () => {},
  });
  await controller.load();
  await controller.save({
    displayName: null,
    bio: null,
    avatarRef: null,
    coverRef: null,
  });
  await controller.retry();
  assert.equal(controller.hasPending, true);
  assert.equal(controller.state.mutation, "unknown");
  assert.equal(saves, 1);
  await assert.rejects(
    controller.save({
      displayName: "Fixture profile",
      bio: null,
      avatarRef: null,
      coverRef: null,
    }),
  );
  controller.dispose();
});

const fields = {
  displayName: "Fixture profile",
  bio: null,
  avatarRef: null,
  coverRef: null,
};
const receiptRead = (receipt: ProfileMutationReceipt | null) =>
  Response.json({ schema: "pirate.community-profile-receipt-read/1", receipt });

for (const status of [401, 403]) {
  test(`actual client preserves ${status} without reading an error body`, async () => {
    let bodyReads = 0;
    const response = new Response("<html>Authentication required</html>", {
      status,
    });
    response.json = async () => {
      bodyReads++;
      throw new Error("auth response must not await a body");
    };
    const client = createProfileClient(
      communityId,
      (async () => response) as typeof fetch,
    );
    await assert.rejects(
      client.owner(new AbortController().signal),
      (error: unknown) =>
        error instanceof ProfileRequestError && error.status === status,
    );
    assert.equal(bodyReads, 0);
  });
}

test("private owner is masked before an authentication-failed reload settles", async () => {
  let lost = false;
  const client = createProfileClient(communityId, (async () =>
    lost
      ? new Response("<html>Sign in</html>", { status: 401 })
      : Response.json(owner)) as typeof fetch);
  const controller = createProfileController({
    client,
    identity: () => ({ authorId, csrf: "fixture", scopeKey: "fixture" }),
    changed: () => {},
  });
  const viewKind = () => controller.state.view.kind;
  await controller.load();
  assert.equal(viewKind(), "ready");
  lost = true;
  const loading = controller.load();
  assert.equal(viewKind(), "loading");
  await loading;
  assert.equal(viewKind(), "anonymous");
  assert.equal("owner" in controller.state.view, false);
  controller.dispose();
});

const failedReads = [
  { status: 0, body: "fixture receipt transport lost" },
  { status: 429, body: '{"error":"rate_limited"}' },
  { status: 408, body: '{"error":"request_timeout"}' },
  { status: 404, body: '{"error":"lookup_unavailable"}' },
  { status: 503, body: "<html>Unavailable</html>" },
  { status: 200, body: "{malformed" },
  { status: 401, body: "" },
  { status: 403, body: "<html>Sign in</html>" },
];
for (const failed of failedReads) {
  test(`committed save/lost ACK survives receipt ${failed.status}/${JSON.stringify(failed.body)} with no extra PUT`, async () => {
    let committed: ProfileMutationReceipt | null = null;
    let mode: "failed" | "recovered" = "failed";
    const writes: string[] = [],
      ids: string[] = [];
    const client = createProfileClient(communityId, (async (url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as ProfileMutation;
        writes.push(String(init.body));
        committed = {
          schema: "pirate.community-profile-mutation/1",
          mutationId: body.mutationId,
          profile: {
            ...owner.profile,
            revision: 1,
            displayName: body.displayName,
          },
        };
        throw new TypeError("fixture committed; ACK lost");
      }
      if (String(url).includes("/mutations/")) {
        ids.push(String(url).split("/").at(-1)!);
        if (!committed) return receiptRead(null);
        if (mode === "failed") {
          if (failed.status === 0) throw new TypeError(failed.body);
          return new Response(failed.body, { status: failed.status });
        }
        return receiptRead(committed);
      }
      return Response.json(owner);
    }) as typeof fetch);
    const controller = createProfileController({
      client,
      identity: () => ({ authorId, csrf: "fixture", scopeKey: "fixture" }),
      changed: () => {},
    });
    await controller.load();
    await controller.save(fields);
    const original = JSON.parse(writes[0]!) as ProfileMutation;
    assert.equal(controller.state.mutation, "unknown");
    await controller.retry();
    assert.equal(controller.hasPending, true);
    assert.equal(controller.state.mutation, "unknown");
    assert.equal(writes.length, 1);
    if (failed.status === 401 || failed.status === 403) {
      assert.equal(controller.state.view.kind, "unavailable");
      assert.equal("owner" in controller.state.view, false);
      await controller.retry(); // authority is unavailable; no lookup or PUT
      assert.equal(ids.length, 2);
    }
    await assert.rejects(
      controller.save({ ...fields, displayName: "Another fixture" }),
    );
    mode = "recovered";
    await controller.load();
    assert.equal(controller.hasPending, true);
    await controller.retry();
    assert.equal(writes.length, 1);
    assert.deepEqual(ids, [
      original.mutationId,
      original.mutationId,
      original.mutationId,
    ]);
    assert.equal(original.expectedRevision, 0);
    assert.deepEqual(
      { ...original, mutationId: undefined, expectedRevision: undefined },
      { ...fields, mutationId: undefined, expectedRevision: undefined },
    );
    assert.equal(controller.hasPending, false);
    assert.equal(controller.state.mutation, "idle");
    assert.equal(
      controller.state.view.kind === "ready" &&
        controller.state.view.owner.profile.revision,
      1,
    );
    controller.dispose();
  });
}

test("successful absent receipt permits only the exact retained command to replay", async () => {
  const client = clientStub(),
    writes: ProfileMutation[] = [];
  client.save = async (body) => {
    writes.push(body);
    if (writes.length === 1) throw new ProfileRequestError(0, "lost ACK");
    return {
      schema: "pirate.community-profile-mutation/1",
      mutationId: body.mutationId,
      profile: { ...owner.profile, revision: 1, displayName: body.displayName },
    };
  };
  const controller = createProfileController({
    client,
    identity: () => ({ authorId, csrf: "fixture", scopeKey: "fixture" }),
    changed: () => {},
  });
  await controller.load();
  await controller.save(fields);
  await controller.retry();
  assert.equal(writes.length, 2);
  assert.equal(writes[0], writes[1]);
  assert.equal(Object.isFrozen(writes[0]), true);
  assert.equal(JSON.stringify(writes[0]), JSON.stringify(writes[1]));
  controller.dispose();
});

for (const status of [401, 403, 408, 429, 409]) {
  test(`actual PUT ${status} has a separate recovery verdict`, async () => {
    const client = createProfileClient(communityId, (async (url, init) => {
      if (init?.method === "PUT")
        return new Response("<html>Refused</html>", { status });
      if (String(url).includes("/mutations/")) return receiptRead(null);
      return Response.json(owner);
    }) as typeof fetch);
    const controller = createProfileController({
      client,
      identity: () => ({ authorId, csrf: "fixture", scopeKey: "fixture" }),
      changed: () => {},
    });
    await controller.load();
    await controller.save(fields);
    assert.equal(controller.hasPending, status !== 409);
    assert.equal(
      controller.state.mutation,
      status === 409 ? "conflict" : "unknown",
    );
    assert.equal(
      controller.state.view.kind,
      status === 401 || status === 403 ? "unavailable" : "ready",
    );
    controller.dispose();
  });
}
