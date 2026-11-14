import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

test(
  "pinned Solid browser runtime uploads the exact finished recording in the same callback despite deferred signals",
  { timeout: 8000 },
  async (t) => {
    const root = new URL("../", import.meta.url);
    const pkg = JSON.parse(
      await readFile(
        new URL("apps/web/node_modules/solid-js/package.json", root),
        "utf8",
      ),
    );
    assert.equal(pkg.version, "2.0.0-rc.21");
    // Direct browser entry avoids Node's server export. No browser process or DOM
    // is started: execute the actual component initialization and callback logic.
    const solid = await import(
      new URL("apps/web/node_modules/solid-js/dist/solid.js", root).href
    );
    const source = await readFile(
      new URL("apps/web/src/media/MediaUpload.tsx", root),
      "utf8",
    );
    const start = source.indexOf("export function MediaUpload(");
    const end = source.indexOf("  const preparing", start);
    assert.ok(start >= 0 && end > start);
    const initializer =
      source.slice(start, end).replace("export function", "function") +
      "return { file, status, busy, error };\n}";
    const compiled = await transform(initializer, {
      loader: "ts",
      target: "esnext",
    });
    const recording = new File(
      [new Uint8Array([8, 5, 3, 1])],
      "private-recording.webm",
      { type: "video/webm" },
    );
    let sawDeferredRead = false,
      reserveCalls = 0,
      uploaded: File | undefined,
      reservedDigest = "";
    const signal = (...args: unknown[]) => {
      const [read, write] = solid.createSignal(...args);
      return [
        read,
        (value: unknown) => {
          const result = write(value);
          if (value === recording) sawDeferredRead = read() !== recording;
          return result;
        },
      ];
    };
    const component = new Function(
      "createSignal",
      "createEffect",
      "onCleanup",
      "mediaErrorText",
      compiled.code + ";return MediaUpload;",
    )(signal, solid.createEffect, solid.onCleanup, (code: string) => code);
    let dispose: (() => void) | undefined;
    t.after(() => dispose?.());
    let completed!: () => void;
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const state = solid.createRoot((cleanup: () => void) => {
      dispose = cleanup;
      return component({
        purpose: "private-review",
        recording,
        capability: { allowed: true, reason: "active_account" },
        onClose() {},
        selection: {
          songKey: "song",
          songRevision: 1,
          startSample: 0,
          durationSamples: 6 * 48000,
          title: "Fixture song",
        },
        client: {
          async reserve(intent: { recordingSha256: string }) {
            reserveCalls++;
            reservedDigest = intent.recordingSha256;
            return {
              id: "same-recording",
              state: "uploading",
              purpose: "private-review",
              canRetry: false,
              expiresAt: Date.now() + 60000,
            };
          },
          async upload(id: string, file: File) {
            assert.equal(id, "same-recording");
            uploaded = file;
            completed();
            return {
              id,
              state: "failed",
              purpose: "private-review",
              canRetry: false,
              expiresAt: Date.now() + 60000,
              error: "fixture_processor_unconfigured",
            };
          },
        },
      });
    });
    solid.flush();
    await done;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    solid.flush();
    assert.equal(
      sawDeferredRead,
      true,
      "the callback must exercise a genuinely deferred file signal",
    );
    assert.equal(reserveCalls, 1);
    assert.equal(uploaded, recording);
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await recording.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    assert.equal(reservedDigest, expected);
    assert.equal(state.status()?.state, "failed");
    assert.equal(state.error(), "");
  },
);
