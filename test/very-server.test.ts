import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { Probe } from "../harness/very/probe.ts";
import { serveProbe } from "../harness/very/server.ts";
import { fakeProvider } from "./very-fixture.ts";

test("an explicit loopback port can keep the same URL across a process restart", async () => {
  const first = await serveProbe(
    new Probe(fakeProvider().provider, "app", "fixture"),
  );
  const url = first.url;
  await first.close();
  const second = await serveProbe(
    new Probe(fakeProvider().provider, "app", "fixture"),
    Number(new URL(url).port),
  );
  try {
    assert.equal(second.url, url);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await second.close();
  }
  for (const port of [-1, 65536, 1.5, NaN])
    await assert.rejects(
      serveProbe(new Probe(fakeProvider().provider, "app", "fixture"), port),
      /invalid_loopback_port/,
    );
});

test("loopback UI requires exact Host, Origin and CSRF for every action", async () => {
  const fake = fakeProvider();
  const probe = new Probe(fake.provider, "app", "fixture");
  const server = await serveProbe(probe);
  try {
    const root = await fetch(server.url);
    assert.equal(root.headers.get("cache-control"), "no-store");
    assert.match(
      root.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(root.headers.get("access-control-allow-origin"), null);
    const html = await root.text();
    const csrf = /const csrf="([a-f0-9]+)"/.exec(html)![1];
    assert.equal(fake.requests.length, 0);
    const refusedHeaders: Record<string, string>[] = [
      {},
      { Origin: server.url },
      { "X-Probe-CSRF": csrf },
      { Origin: "https://foreign.invalid", "X-Probe-CSRF": csrf },
      { Origin: server.url, "X-Probe-CSRF": "é".repeat(64) },
    ];
    for (const headers of refusedHeaders) {
      assert.equal(
        (await fetch(`${server.url}/start`, { method: "POST", headers }))
          .status,
        403,
      );
    }
    const wrongHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          server.url,
          { headers: { Host: "foreign.invalid" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(`${server.url}/start`)).status, 405);
    const headers = { Origin: server.url, "X-Probe-CSRF": csrf };
    assert.equal(
      (
        await fetch(`${server.url}/start`, {
          method: "POST",
          headers,
          body: "endpoint=https://foreign.invalid",
        })
      ).status,
      403,
    );
    assert.equal(fake.requests.length, 0);
    const started = (await (
      await fetch(`${server.url}/start`, { method: "POST", headers })
    ).json()) as ReturnType<Probe["view"]> & { qr: string };
    assert.equal(started.report.mode, "fixture");
    assert.match(started.qr, /^<svg/);
    assert.match(started.launch!, /^veros:\/\/verify\?/);
    assert.equal(fake.requests.length, 1);
    await fetch(`${server.url}/poll`, { method: "POST", headers });
    const reset = (await (
      await fetch(`${server.url}/reset`, { method: "POST", headers })
    ).json()) as ReturnType<Probe["view"]>;
    assert.equal(reset.launch, null);
    assert.deepEqual(reset.report.observations, []);
  } finally {
    await server.close();
  }
});
