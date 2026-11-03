import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { rewardPage } from "../harness/very/reward-page.ts";

test("reward page resumes interrupted polling through an unknown transaction outcome", async () => {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        addEventListener() {},
        disabled: false,
        hidden: false,
        textContent: "",
        innerHTML: "",
      });
    return elements.get(id);
  };
  const states = [
    "waiting",
    "network-error",
    "registration_unknown",
    "complete",
  ];
  const calls: string[] = [];
  let tick: (() => void) | undefined;
  const context = createContext({
    document: { getElementById: element },
    AbortSignal,
    setTimeout(fn: () => void) {
      tick = fn;
      return 1;
    },
    clearTimeout() {
      tick = undefined;
    },
    async fetch(path: string, options: RequestInit) {
      calls.push(path);
      assert.ok(options.signal);
      const state = states.shift();
      assert.ok(state);
      if (state === "network-error") throw new Error("offline");
      return {
        ok: true,
        json: async () => ({
          state,
          busy: false,
          launch: null,
          qr: null,
          report: { complete: state === "complete" },
        }),
      };
    },
  });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
    rewardPage("fixture", "nonce"),
  )![1];
  runInContext(script, context);
  await setImmediate();
  assert.equal(element("start").disabled, true);
  for (let i = 0; i < 3; i++) {
    assert.ok(tick);
    tick();
    await setImmediate();
  }
  assert.equal(element("state").textContent, "State: complete");
  assert.equal(tick, undefined);
  assert.deepEqual(calls, ["/state", "/poll", "/poll", "/poll"]);
});
