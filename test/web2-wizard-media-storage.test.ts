import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hostedWizardFixture } from "./fixtures/web2-hosted-wizard.ts";

// The paired operator saves the community-owned Filebase token through the
// actual wizard HTTP surface into the real encrypted vault on the real key
// agent. The Filebase provider is the one injected boundary. Proves the
// check-before-save ordering, refresh and restart recovery without the token,
// rotation with failure safety, revocation discovery, request-id recovery of
// an interrupted save, and that no secret value ever reaches a response.
test(
  "paired wizard saves, recovers and rotates the community media token",
  { timeout: 120000 },
  async () => {
    const f = await hostedWizardFixture();
    try {
      const requestId = () => randomBytes(16).toString("hex");
      type StorageView = {
        busy?: boolean;
        mediaStorage: {
          state: string;
          generation?: number;
          pinCount?: number;
          observation?: { outcome: string; pinCount?: number };
        } | null;
        outcome?: { state: string; generation?: number; recovered?: boolean };
      };
      const asStorage = (view: unknown) => view as StorageView;

      let view = asStorage(await f.state());
      assert.equal(view.mediaStorage?.state, "empty");

      // Save a working token: one read-only probe, then a durable commit.
      f.filebase.accepted.set("token-alpha", 3);
      const alpha = requestId();
      view = asStorage(
        await f.send("storage-save", {
          token: "token-alpha",
          requestId: alpha,
          baseGeneration: null,
        }),
      );
      assert.equal(view.outcome?.state, "saved");
      assert.equal(view.outcome?.generation, 1);
      assert.equal(
        view.busy,
        false,
        "a completed save must not return a still-busy view",
      );
      assert.equal(view.mediaStorage?.state, "saved");
      assert.equal(view.mediaStorage?.generation, 1);
      assert.equal(view.mediaStorage?.pinCount, 3);
      assert.equal(f.filebase.calls.length, 1);
      assert.match(f.filebase.calls[0]!.path, /pin\/ls/);
      assert.equal(
        f.filebase.calls[0]!.authorization,
        "Bearer token-alpha",
      );

      // Restart the whole wizard service: the committed generation is
      // recovered from the vault without the token being asked again.
      await f.restart();
      view = asStorage(await f.state());
      assert.equal(view.mediaStorage?.state, "saved");
      assert.equal(view.mediaStorage?.generation, 1);

      // A declined replacement writes nothing and leaves generation 1 active.
      view = asStorage(
        await f.send("storage-save", {
          token: "token-refused",
          requestId: requestId(),
          baseGeneration: 1,
        }),
      );
      assert.equal(view.outcome?.state, "declined");
      assert.equal(view.mediaStorage?.generation, 1);

      // A stale tab holding generation zero cannot overwrite the active
      // generation: refused before any provider effect.
      const callsBeforeStale = f.filebase.calls.length;
      const stale = await f.post("storage-save", {
        token: "token-bravo",
        requestId: requestId(),
        baseGeneration: null,
      });
      assert.equal(stale.status, 409);
      assert.equal(
        (stale.body as { code?: string }).code,
        "media_storage_generation_changed",
      );
      assert.equal(f.filebase.calls.length, callsBeforeStale);
      assert.equal(
        f.filebase.calls.filter((c) => c.authorization === "Bearer token-alpha").length,
        1,
        "the check probe is read-only; the saved token is not re-probed on save attempts",
      );

      // A working replacement rotates the active generation.
      f.filebase.accepted.set("token-bravo", 0);
      const bravo = requestId();
      view = asStorage(
        await f.send("storage-save", {
          token: "token-bravo",
          requestId: bravo,
          baseGeneration: 1,
        }),
      );
      assert.equal(view.outcome?.state, "saved");
      assert.equal(view.outcome?.generation, 2);
      assert.equal(view.outcome?.recovered, false);
      assert.equal(view.mediaStorage?.generation, 2);

      // The acceptance case: the identical save repeated across a restart —
      // the original generation is recovered with no new probe and no second
      // generation.
      const probesBeforeRetry = f.filebase.calls.length;
      await f.restart();
      view = asStorage(
        await f.send("storage-save", {
          token: "token-bravo",
          requestId: bravo,
          baseGeneration: 1,
        }),
      );
      assert.equal(view.outcome?.state, "saved");
      assert.equal(view.outcome?.generation, 2);
      assert.equal(view.outcome?.recovered, true);
      assert.equal(
        f.filebase.calls.length,
        probesBeforeRetry,
        "a repeated save must not probe the provider again",
      );
      assert.equal(view.mediaStorage?.generation, 2);

      // Interrupted-save recovery is by request id only, never the token.
      view = asStorage(await f.send("storage-reconcile", { requestId: bravo }));
      assert.equal(view.outcome?.state, "saved");
      assert.equal(view.outcome?.generation, 2);
      view = asStorage(
        await f.send("storage-reconcile", { requestId: requestId() }),
      );
      assert.equal(view.outcome?.state, "not-saved");

      // The operator can re-check the saved token; revocation at the provider
      // is discovered as declined while the generation stays usable.
      view = asStorage(await f.send("storage-check", {}));
      assert.equal(view.outcome?.state, "ok");
      f.filebase.accepted.delete("token-bravo");
      view = asStorage(await f.send("storage-check", {}));
      assert.equal(view.outcome?.state, "declined");
      assert.equal(view.mediaStorage?.state, "saved");
      assert.equal(view.mediaStorage?.generation, 2);

      // The declined observation is durable: after a restart the view still
      // says the stored token is declined rather than reverting to bare saved.
      await f.restart();
      view = asStorage(await f.state());
      assert.equal(view.mediaStorage?.state, "saved");
      assert.equal(view.mediaStorage?.generation, 2);
      assert.equal(view.mediaStorage?.observation?.outcome, "declined");

      // No secret value ever appears in any response body.
      const finalState = await f.raw("GET", "/api/web2/state");
      const wire = JSON.stringify(finalState.body);
      assert(!wire.includes("token-alpha"));
      assert(!wire.includes("token-bravo"));
      assert(!wire.includes("token-refused"));

      // Every provider call across the whole run was the read-only pin-list
      // endpoint; no pin addition or mutation ever reaches the provider.
      assert(
        f.filebase.calls.every((c) => c.path.includes("/pin/ls")),
        "no write operation reaches the provider during credential custody",
      );
    } finally {
      await f.close();
    }
  },
);
