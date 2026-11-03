import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { page } from "../harness/very/page.ts";

// Execute the actual browser script. Observe rendered controls and HTTP calls,
// without reusing the polling decisions as a test oracle.
async function browser(responses: Array<object | Error>) {
  const elements = new Map<string, any>();
  const calls: string[] = [];
  let tick!: () => void;
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        disabled: false,
        hidden: false,
        textContent: "",
        innerHTML: "",
        href: "",
        replaceChildren() {
          this.innerHTML = "";
        },
        removeAttribute(name: string) {
          if (name === "href") this.href = "";
        },
      });
    return elements.get(id);
  };
  const context = createContext({
    document: { getElementById: element },
    AbortSignal,
    setInterval(fn: () => void) {
      tick = fn;
    },
    async fetch(path: string, options: RequestInit) {
      calls.push(path);
      assert.ok(options.signal, "every browser request has a timeout");
      const response = responses.shift();
      if (!response) throw new Error("unexpected_request");
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
  });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
    page("fixture-csrf", "fixture-nonce"),
  )![1];
  runInContext(script, context);
  await setImmediate();
  return {
    element,
    calls,
    async tick() {
      tick();
      await setImmediate();
    },
  };
}

function view(state: string, busy = false) {
  return {
    state,
    busy,
    error: null,
    next: "Next case",
    launch: null,
    qr: null,
    report: { mode: "fixture", complete: false, observations: [] },
  };
}

test("a lost browser response recovers polling and re-enables the next request", async () => {
  const ui = await browser([
    view("waiting"),
    new Error("connection_lost"),
    view("verifying", true),
    view("ready"),
  ]);
  assert.equal(ui.element("start").disabled, true);
  await ui.tick();
  assert.match(ui.element("status").textContent, /retrying/);
  assert.equal(ui.element("start").disabled, true);
  await ui.tick();
  assert.equal(ui.element("status").textContent, "State: verifying");
  await ui.tick();
  assert.equal(ui.element("status").textContent, "State: ready");
  assert.equal(ui.element("start").disabled, false);
  assert.deepEqual(ui.calls, ["/state", "/poll", "/poll", "/poll"]);
  await ui.tick();
  assert.equal(ui.calls.length, 4, "ready state stops automatic polling");
});

test("reload during creation or verification keeps polling until a terminal result", async () => {
  for (const state of ["starting", "verifying"]) {
    const ui = await browser([view(state, true), view("failed")]);
    assert.equal(ui.element("start").disabled, true);
    await ui.tick();
    assert.equal(ui.element("status").textContent, "State: failed");
    assert.equal(ui.element("start").disabled, false);
    assert.deepEqual(ui.calls, ["/state", "/poll"]);
  }
});
