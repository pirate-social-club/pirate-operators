/** UNRUN. Actual same-origin client/command codec with a named durable-journal
 * simulation and intercepted HTTP, no network/provider/backend acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDanceClient,
  DanceClientError,
  privateAccessLost,
} from "../src/dance/client.ts";
import {
  identicalCommand,
  type DanceJournal,
  type DanceJournalEntry,
} from "../src/dance/journal.ts";
import { captureFixture, scope } from "./dance-source-fixtures.ts";
function simulatedJournal() {
  let active: DanceJournalEntry | null = null,
    latest: DanceJournalEntry | null = null;
  const accepted = new Map<string, DanceJournalEntry>();
  const journal: DanceJournal = {
    reserve: async (e) => {
      if (active) return active;
      if (accepted.has(e.subject)) return accepted.get(e.subject)!;
      active = e;
      return e;
    },
    active: async () => active,
    latest: async () => latest,
    acknowledge: async () => {
      latest = null;
    },
    accept: async (e, receiptJson) => {
      assert.equal(active?.commandId, e.commandId);
      assert.equal(identicalCommand(active!, e), true);
      latest = { ...e, receiptJson };
      accepted.set(e.subject, latest);
      active = null;
    },
    definiteCaptureReset: async () => {
      if (active) throw Error("dance_response_unknown");
      accepted.delete("capture");
    },
    rejectExpired: async (e) => {
      assert.equal(active?.commandId, e.commandId);
      active = null;
    },
  };
  return { journal, pending: () => active };
}
test("GET observation after lost write never replays; explicit recovery returns original bytes/id and actual receipt", async () => {
  const j = simulatedJournal(),
    bodies: string[] = [];
  let lose = true;
  const fetcher = (async (_url, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(
      new Headers(init?.headers).get("x-dance-account"),
      scope.accountId,
    );
    if (!init?.method) return Response.json({ status: "read_only_fixture" });
    bodies.push(String(init.body));
    assert.equal(new Headers(init.headers).get("x-csrf-token"), "fixture_csrf");
    if (lose) {
      lose = false;
      throw TypeError("reply_lost_after_commit_simulation");
    }
    const original = JSON.parse(String(init.body)) as { commandId: string };
    return Response.json({
      version: "pirate.dance/1",
      commandId: original.commandId,
      reviewId: "capture",
      revision: 1,
      state: "awaiting_review",
      intentId: null,
    });
  }) as typeof fetch;
  const make = () =>
    createDanceClient({
      communityId: scope.communityId,
      accountId: scope.accountId,
      csrf: "fixture_csrf",
      isCurrent: () => true,
      journal: j.journal,
      fetcher,
    });
  const first = make();
  await assert.rejects(
    first.submit("capture", "media", "a".repeat(64)),
    (e) => e instanceof DanceClientError && e.unknown,
  );
  const original = structuredClone(j.pending());
  assert.ok(original);
  const reload = make();
  await reload.observe!("capture");
  assert.equal(bodies.length, 1);
  assert.deepEqual(j.pending(), original);
  const receipt = await reload.recover();
  assert.equal(bodies[0], bodies[1]);
  assert.equal(receipt?.commandId, original.commandId);
  assert.equal(JSON.parse(receipt!.receiptJson!).commandId, original.commandId);
  assert.equal(j.pending(), null);
});
for (const status of [401, 403])
  test(`plain-text ${status} keeps authoritative denial instead of JSON failure`, async () => {
    const client = createDanceClient({
      communityId: scope.communityId,
      accountId: scope.accountId,
      csrf: "fixture_csrf",
      isCurrent: () => true,
      journal: simulatedJournal().journal,
      fetcher: (async () =>
        new Response("access denied", { status })) as typeof fetch,
    });
    await assert.rejects(
      client.observe!("capture"),
      (e) =>
        e instanceof DanceClientError &&
        e.status === status &&
        privateAccessLost(e),
    );
  });
test("abort retains original pending command; different action recovers it and never retargets", async () => {
  const j = simulatedJournal(),
    requests: string[] = [];
  const abort = new AbortController();
  abort.abort();
  const client = createDanceClient({
    communityId: scope.communityId,
    accountId: scope.accountId,
    csrf: "fixture_csrf",
    isCurrent: () => true,
    journal: j.journal,
    fetcher: (async (url, init) => {
      requests.push(String(url));
      init?.signal?.throwIfAborted();
      return Response.json({
        commandId: j.pending()!.commandId,
        reviewId: "capture",
        revision: 1,
        state: "awaiting_review",
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    client.submit("capture", "media", "a".repeat(64), abort.signal),
  );
  const original = j.pending()!.bodyJson;
  await assert.rejects(
    client.withdraw("capture", 1),
    /original_command_recovered/,
  );
  assert.equal(
    requests.every((path) => path === "/api/dance/reviews"),
    true,
  );
  assert.equal(JSON.parse(original).mediaId, "media");
});
test("same-account session invalidation during response decoding cannot return private data", async () => {
  const j = simulatedJournal();
  let current = true,
    respond!: (r: Response) => void;
  const client = createDanceClient({
    communityId: scope.communityId,
    accountId: scope.accountId,
    csrf: "fixture_csrf",
    isCurrent: () => current,
    journal: j.journal,
    fetcher: (async () =>
      new Promise((r) => {
        respond = r;
      })) as typeof fetch,
  });
  const pending = client.observe!("capture");
  current = false;
  respond(Response.json(captureFixture()));
  await assert.rejects(pending, (e) => privateAccessLost(e));
});
