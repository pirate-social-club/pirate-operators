// UNRUN source: actual HTTP/CSRF and operator-session boundary over ephemeral
// loopback, with controlled lifecycle ports. No Linux/provider acceptance.
import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { createWizardServer } from "../apps/community-wizard/server/http.ts";
import { LinuxInputError, record, text } from "../packages/community-setup/shared-linux-profile.ts";
import { linuxFixture } from "./community-wizard-linux-fixture.ts";
async function listening(server: ReturnType<typeof createWizardServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: ReturnType<typeof createWizardServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
test("an unmounted Linux backend is explicitly unavailable and cannot deploy via legacy setup-page provisioning", async (t) => {
  const server = createWizardServer(undefined, "/unused-fixture-dist", {
    infisical: false,
    cloudflare: false,
  });
  const origin = await listening(server);
  t.after(() => close(server));
  const response = await fetch(`${origin}/api/linux/state`),
    state = record(await response.json());
  assert.equal(state.available, false);
  assert.equal(state.legacyAvailable, false);
  assert.equal("state" in state, false, "no fake ready/deployed state");
  const deploy = await fetch(`${origin}/api/linux/deploy`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-wizard-token": text(state.csrf,64),
    },
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(deploy.status, 503);
});
test("Linux mounting requires actual operator authentication; loopback and a CSRF token alone do not authorize writes", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  assert.throws(
    () =>
      createWizardServer(
        undefined,
        "/unused-fixture-dist",
        { infisical: false, cloudflare: false },
        { linux: f.setup },
      ),
    /authenticated operator session/,
  );
  const server = createWizardServer(
    undefined,
    "/unused-fixture-dist",
    { infisical: false, cloudflare: false },
    {
      linux: f.setup,
      authorizeLinux: async (req) => {
        if (req.headers.cookie !== "fixture_operator=paired")
          throw new LinuxInputError(
            "operator_pairing_required",
            "Pair this operator session through the actual bootstrap.",
          );
      },
    },
  );
  const origin = await listening(server);
  t.after(() => close(server));
  assert.equal((await fetch(`${origin}/api/linux/state`)).status, 401);
  const session = { cookie: "fixture_operator=paired" };
  const state = record(await (
    await fetch(`${origin}/api/linux/state`, { headers: session })
  ).json());
  assert.equal(state.available, true);
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${origin}/api/linux/destination`, {
      method: "POST",
      headers: {
        ...session,
        origin,
        "content-type": "application/json",
        "x-wizard-token": text(state.csrf,64),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post(
        { origin: "https://unrelated.example" },
        { revision: 0, mode: "restore", target: { kind: "local-linux" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        { "x-wizard-token": "wrong" },
        { revision: 0, mode: "restore", target: { kind: "local-linux" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        {},
        {
          revision: 0,
          mode: "restore",
          target: { kind: "local-linux" },
          authoritySuccess: true,
        },
      )
    ).status,
    409,
  );
  const saved = await post(
    {},
    { revision: 0, mode: "restore", target: { kind: "local-linux" } },
  );
  assert.equal(saved.status, 200);
  assert.equal(record(record(record(await saved.json()).state).destination).mode, "restore");
  assert.equal(f.facts.nativeIntents.length, 0);
});

test("actual HTTP ciphertext streaming outlives the metadata bound and keeps an independent absolute/idle bound", async (t) => {
  const f = await linuxFixture({ timeoutMs: 10, uploadTimeoutMs: 500 });
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  const server = createWizardServer(
    undefined,
    "/unused-fixture-dist",
    { infisical: false, cloudflare: false },
    {
      linux: f.setup,
      authorizeLinux: async (req) => {
        if (req.headers.cookie !== "fixture_operator=paired")
          throw new LinuxInputError(
            "operator_pairing_required",
            "Pair this operator.",
          );
      },
    },
  );
  assert.equal(
    server.requestTimeout,
    3_600_000,
    "upload allowance must be actual code, not a commented assignment",
  );
  assert.equal(server.headersTimeout, 10_000);
  const origin = await listening(server);
  t.after(() => close(server));
  const session = { cookie: "fixture_operator=paired" };
  const state = record(await (
    await fetch(origin + "/api/linux/state", { headers: session })
  ).json());
  const bytes = Buffer.from(
    "controlled ciphertext stream fixture; not real encryption",
  );
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      origin + "/api/linux/backup",
      {
        method: "POST",
        headers: {
          ...session,
          origin,
          "content-type": "application/octet-stream",
          "x-wizard-token": text(state.csrf,64),
          "x-backup-size": String(bytes.length),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      },
    );
    req.once("error", reject);
    req.write(bytes.subarray(0, 4));
    setTimeout(() => req.end(bytes.subarray(4)), 30);
  });
  assert.equal(status, 200);
  assert.ok(f.setup.snapshot().backupId);
  assert.equal(f.setup.snapshot().uploadRequest, null);
  assert.equal(f.facts.nativeIntents.length, 0);
});
