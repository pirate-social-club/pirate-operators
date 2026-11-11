import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { createPendingSubmissionEnvelope } from "../post-composer/pending-submission";
import type { TextContentSubmissionV1 } from "../post-composer/text-submission-contract";
import {
  AmbiguousTextSubmissionError,
  IdempotencyConflictError,
  TextSubmissionAuthenticationRequiredError,
  TextSubmissionServerRejectionError,
  type TextSubmissionTransport,
} from "../post-composer/text-submission-transport";
import { ATTEMPT_TIMEOUT_MS, createTextSubmissionMachine, DELAYED_AFTER_ATTEMPTS, retryDelayMs } from "./text-submission-machine";

const published: TextContentSubmissionV1 = {
  submission_id: "sub-1",
  href: "/text-content-submissions/sub-1",
  surface: "text_post",
  status: "published",
  result: { decision: "allow", reason_code: null },
  published_resource: { kind: "post", post_id: "post-1", href: "/posts/post-1" },
  review_ref: null,
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
};
const held: TextContentSubmissionV1 = {
  ...published,
  status: "manual_review",
  result: { decision: "manual_review", reason_code: "review_required" },
  published_resource: null,
  review_ref: "review-1",
};

async function envelope() {
  return createPendingSubmissionEnvelope({
    request: {
      path: { communityId: "community-1" },
      body: {
        idempotency_key: "key-1",
        persona_id: "persona-1",
        post_type: "text",
        authorship_mode: "human_direct",
        identity_mode: "public",
        visibility: "public",
        author_declared_rating: "general",
        title: null,
        body: "Hello world",
      },
    },
    pendingRequestId: "pending-1",
    createdAt: "2026-10-06T00:00:00.000Z",
  });
}

async function run(transport: TextSubmissionTransport) {
  const actor = createActor(createTextSubmissionMachine(transport), { input: { envelope: await envelope() } });
  actor.start();
  return actor;
}

function controlledStatusRead() {
  let resolve!: (snapshot: TextContentSubmissionV1 | null) => void;
  const response = new Promise<TextContentSubmissionV1 | null>((settle) => { resolve = settle; });
  return { read: vi.fn(() => response), resolve };
}

describe("text submission machine", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("publishes on the first answer", async () => {
    const dispatch = vi.fn(async () => published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("published");
    expect(actor.getSnapshot().context.postId).toBe("post-1");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("replays the same request after a lost acknowledgement and confirms", async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new AmbiguousTextSubmissionError())
      .mockResolvedValueOnce(published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("waiting");
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(actor.getSnapshot().value).toBe("published");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0]).toBe(dispatch.mock.calls[0]![0]);
  });

  it("keeps trying while the connection is down and never reports a refusal", async () => {
    const dispatch = vi.fn(async () => { throw new AmbiguousTextSubmissionError(); });
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actor.getSnapshot().context.attempts).toBeGreaterThanOrEqual(DELAYED_AFTER_ATTEMPTS);
    expect(actor.getSnapshot().context.rejection).toBeNull();
    expect(actor.getSnapshot().status).toBe("active");
    actor.stop();
  });

  it("treats an unanswered request as unconfirmed and replays it", async () => {
    const dispatch = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce(published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS);
    expect(actor.getSnapshot().value).toBe("waiting");
    expect(actor.getSnapshot().context.rejection).toBeNull();
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(actor.getSnapshot().value).toBe("published");
    expect(dispatch.mock.calls[1]![0]).toBe(dispatch.mock.calls[0]![0]);
  });

  it("retries at once when asked", async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new AmbiguousTextSubmissionError())
      .mockResolvedValueOnce(published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    actor.send({ type: "RETRY" });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("published");
  });

  it("holds the request when the session is gone and replays it unchanged once signed in", async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new TextSubmissionAuthenticationRequiredError())
      .mockResolvedValueOnce(published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("signInRequired");
    // No timer sends it again.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().context.rejection).toBeNull();
    actor.send({ type: "RESUME" });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("published");
    expect(dispatch.mock.calls[1]![0]).toBe(dispatch.mock.calls[0]![0]);
  });

  it("pauses an unconfirmed request on sign-out and still reconciles it on resume", async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new AmbiguousTextSubmissionError())
      .mockResolvedValueOnce(published);
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    actor.send({ type: "PAUSE" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    actor.send({ type: "RESUME" });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("published");
  });

  it("does not dispatch after PAUSE while a known-submission read is pending", async () => {
    const originalEnvelope = { ...await envelope(), submission_id: "sub-1" };
    const statusRead = controlledStatusRead();
    const dispatch = vi.fn<TextSubmissionTransport["dispatch"]>(async () => published);
    const actor = createActor(createTextSubmissionMachine({ dispatch, read: statusRead.read }), {
      input: { envelope: originalEnvelope },
    });
    actor.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(statusRead.read).toHaveBeenCalledWith("sub-1");
      expect(dispatch).not.toHaveBeenCalled();
      actor.send({ type: "PAUSE" });
      statusRead.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect(actor.getSnapshot().value).toBe("signInRequired");
    } finally {
      actor.stop();
    }
  });

  it("does not dispatch after actor.stop while a known-submission read is pending", async () => {
    const originalEnvelope = { ...await envelope(), submission_id: "sub-1" };
    const statusRead = controlledStatusRead();
    const dispatch = vi.fn<TextSubmissionTransport["dispatch"]>(async () => published);
    const actor = createActor(createTextSubmissionMachine({ dispatch, read: statusRead.read }), {
      input: { envelope: originalEnvelope },
    });
    actor.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(statusRead.read).toHaveBeenCalledWith("sub-1");
      expect(dispatch).not.toHaveBeenCalled();
      actor.stop();
      statusRead.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect(actor.getSnapshot().status).toBe("stopped");
    } finally {
      actor.stop();
    }
  });

  it("dispatches the original envelope once after a live known-submission read returns null", async () => {
    const originalEnvelope = { ...await envelope(), submission_id: "sub-1" };
    const statusRead = controlledStatusRead();
    const dispatch = vi.fn<TextSubmissionTransport["dispatch"]>(async () => published);
    const actor = createActor(createTextSubmissionMachine({ dispatch, read: statusRead.read }), {
      input: { envelope: originalEnvelope },
    });
    actor.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(statusRead.read).toHaveBeenCalledWith("sub-1");
      expect(dispatch).not.toHaveBeenCalled();
      statusRead.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![0]).toBe(originalEnvelope);
      expect(actor.getSnapshot().value).toBe("published");
    } finally {
      actor.stop();
    }
  });

  it("does not replay a paused status read reached through an idempotency conflict", async () => {
    const statusRead = controlledStatusRead();
    const dispatch = vi.fn<TextSubmissionTransport["dispatch"]>()
      .mockRejectedValueOnce(new IdempotencyConflictError("sub-1"))
      .mockResolvedValue(published);
    const actor = await run({ dispatch, read: statusRead.read });
    try {
      await vi.advanceTimersByTimeAsync(retryDelayMs(1));
      expect(statusRead.read).toHaveBeenCalledWith("sub-1");
      expect(dispatch).toHaveBeenCalledTimes(1);
      actor.send({ type: "PAUSE" });
      statusRead.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(actor.getSnapshot().value).toBe("signInRequired");
    } finally {
      actor.stop();
    }
  });

  it("stops on a definitive refusal", async () => {
    const dispatch = vi.fn(async () => { throw new TextSubmissionServerRejectionError(403, "membership_required"); });
    const actor = await run({ dispatch, read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("rejected");
    expect(actor.getSnapshot().context.rejection).toBe("not_allowed");
  });

  it("reads the bound submission after an idempotency conflict instead of sending again", async () => {
    const dispatch = vi.fn(async () => { throw new IdempotencyConflictError("sub-1"); });
    const read = vi.fn(async () => published);
    const actor = await run({ dispatch, read });
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(actor.getSnapshot().value).toBe("published");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("sub-1");
  });

  it("reports a held post as held, not published", async () => {
    const actor = await run({ dispatch: vi.fn(async () => held), read: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(actor.getSnapshot().value).toBe("rejected");
    expect(actor.getSnapshot().context.rejection).toBe("held");
  });
});
