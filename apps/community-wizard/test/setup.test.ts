import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createSetup, type Provisioner } from "../server/setup.ts";
import { createWizardServer } from "../server/http.ts";
import { HealthPending } from "../server/health.ts";
import {
  settingsFrom,
  secretsFrom,
  type Settings,
  type SecretName,
} from "../server/model.ts";
import type { SecretStore } from "../server/secrets.ts";

const settings: Settings = {
  name: "Local test",
  slug: "local-test",
  accountId: "a".repeat(32),
  subdomain: "example",
  projectId: "00000000-0000-0000-0000-000000000001",
  environment: "dev",
  secretPath: "/communities/local-test",
  acrHost: "identify-eu-west-1.acrcloud.com",
  cloudconvert: false,
  tld: "",
  moderationMode: "independent",
};
const credentials = {
  OPENAI_API_KEY: "fixture-openai-not-a-real-key",
  ACRCLOUD_ACCESS_KEY: "fixture-acr-not-a-real-key",
  ACRCLOUD_ACCESS_SECRET: "fixture-acr-not-a-real-secret",
};
async function fixture(t: TestContext, options: Partial<Provisioner> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pirate-wizard-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved: Record<string, string> = {};
  let calls = 0;
  const secrets: SecretStore = {
    async save(_s, values) {
      Object.assign(saved, values);
      return Object.keys(saved) as SecretName[];
    },
    async read() {
      return { ...saved };
    },
  };
  const provision: Provisioner = {
    async health() {},
    async digest() {
      return "source-v1";
    },
    async deploy() {
      calls++;
    },
    ...options,
  };
  const setup = await createSetup(directory, secrets, provision);
  return { directory, setup, secrets, provision, calls: () => calls };
}
test("credentials never enter persisted/public state; successful provision is not first-song readiness", async (t) => {
  const f = await fixture(t);
  await f.setup.configure(settings);
  await f.setup.saveSecrets(credentials);
  await f.setup.review();
  await f.setup.deploy({ planId: f.setup.snapshot().plan!.id });
  await f.setup.settled();
  assert.equal(f.calls(), 1);
  assert.equal(f.setup.snapshot().deployment, "provisioned");
  assert.equal(f.setup.snapshot().readiness.at(-1)?.state, "not_ready");
  const disk = await readFile(join(f.directory, "setup.json"), "utf8");
  for (const value of Object.values(credentials)) {
    assert.ok(!disk.includes(value));
    assert.ok(!JSON.stringify(f.setup.snapshot()).includes(value));
  }
  assert.equal(
    (await stat(join(f.directory, "setup.json"))).mode & 0o777,
    0o600,
  );
  const resumed = await createSetup(f.directory, f.secrets, f.provision);
  assert.equal(resumed.snapshot().deployment, "provisioned");
  assert.deepEqual(resumed.snapshot().settings, settings);
});
test("settings and source changes invalidate reviewed plans without deployment", async (t) => {
  const f = await fixture(t);
  await f.setup.configure(settings);
  await f.setup.saveSecrets(credentials);
  await f.setup.review();
  const old = f.setup.snapshot().plan!.id;
  await f.setup.configure({ ...settings, name: "Changed" });
  await assert.rejects(
    () => f.setup.deploy({ planId: old }),
    /Review the current plan/,
  );
  await f.setup.review();
  f.provision.digest = async () => "source-v2";
  await assert.rejects(
    () => f.setup.deploy({ planId: f.setup.snapshot().plan!.id }),
    /source changed/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(f.setup.snapshot().busy, false);
});
test("deployment cannot bypass missing secrets; changing Infisical scope clears saved status", async (t) => {
  const f = await fixture(t);
  await f.setup.configure(settings);
  await f.setup.review();
  await assert.rejects(
    () => f.setup.deploy({ planId: f.setup.snapshot().plan!.id }),
    /required credentials/,
  );
  await f.setup.saveSecrets(credentials);
  await f.setup.configure({ ...settings, secretPath: "/another-community" });
  assert.deepEqual(f.setup.snapshot().secrets, []);
});
test("failed apply retries identical resources and refuses concurrent mutation or identity changes", async (t) => {
  let release!: () => void;
  let fail = true;
  let attempts = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    async deploy() {
      attempts++;
      await wait;
      if (fail) throw new Error("private provider error");
    },
  });
  await f.setup.configure(settings);
  await f.setup.saveSecrets(credentials);
  await f.setup.review();
  const id = f.setup.snapshot().plan!.id;
  await f.setup.deploy({ planId: id });
  await assert.rejects(() => f.setup.configure(settings), /running/);
  await assert.rejects(() => f.setup.deploy({ planId: id }), /running/);
  release();
  await f.setup.settled();
  assert.equal(f.setup.snapshot().deployment, "failed");
  assert.ok(
    !JSON.stringify(f.setup.snapshot()).includes("private provider error"),
  );
  await assert.rejects(
    () => f.setup.configure({ ...settings, slug: "different" }),
    /deployment has started/,
  );
  fail = false;
  await f.setup.deploy({ planId: id });
  await f.setup.settled();
  assert.equal(attempts, 2);
  assert.equal(f.setup.snapshot().plan!.id, id);
});
test("restart exposes uncertain deployment as interrupted rather than success", async (t) => {
  const f = await fixture(t);
  await f.setup.configure(settings);
  await f.setup.review();
  const state = {
    ...f.setup.snapshot(),
    deployment: "running",
    attempted: true,
  };
  await writeFile(join(f.directory, "setup.json"), JSON.stringify(state));
  const resumed = await createSetup(f.directory, f.secrets, f.provision);
  assert.equal(resumed.snapshot().deployment, "interrupted");
  assert.equal(resumed.snapshot().readiness.at(-1)?.state, "not_ready");
});
test("HTTP rejects cross-origin, rebinding hosts, missing CSRF, oversized bodies and secret-bearing errors", async (t) => {
  const f = await fixture(t);
  f.secrets.save = async () => {
    throw new Error("fixture-leaked-token");
  };
  const server = createWizardServer(f.setup, f.directory, {
    infisical: true,
    cloudflare: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal(
    (
      await fetch(`${origin}/api/state`, {
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    request(
      `${origin}/api/state`,
      { headers: { Host: "rebinding.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    )
      .on("error", reject)
      .end();
  });
  assert.equal(rebound, 403);
  const state = await (await fetch(`${origin}/api/state`)).json();
  const post = (path: string, payload: unknown, token = state.csrf) =>
    fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Wizard-Token": token,
      },
      body: JSON.stringify(payload),
    });
  assert.equal((await post("settings", settings, "")).status, 403);
  assert.equal((await post("settings", settings)).status, 200);
  assert.equal(
    (await post("settings", { name: "a".repeat(30_000) })).status,
    413,
  );
  const failed = await post("secrets", credentials);
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes("fixture-leaked-token"));
});
test("configuration rejects path/shell/URL injection and provider secrets in settings", () => {
  for (const patch of [
    { slug: "$(command)" },
    { subdomain: "example.com/path" },
    { secretPath: "/../other" },
    { acrHost: "127.0.0.1" },
    { accountId: "wrong" },
    { OPENAI_API_KEY: "secret" },
  ])
    assert.throws(() => settingsFrom({ ...settings, ...patch }));
  assert.throws(() => secretsFrom({ PRIVATE_KEY: "arbitrary key" }));
});

test("saved credential changes and a new source plan require redeployment", async (t) => {
  const f = await fixture(t);
  await f.setup.configure(settings);
  await f.setup.saveSecrets(credentials);
  await f.setup.review();
  await f.setup.deploy({ planId: f.setup.snapshot().plan!.id });
  await f.setup.settled();
  await f.setup.saveSecrets({
    ...credentials,
    OPENAI_API_KEY: "fixture-new-key",
  });
  assert.equal(f.setup.snapshot().deployment, "update_pending");
  await f.setup.review();
  await f.setup.deploy({ planId: f.setup.snapshot().plan!.id });
  await f.setup.settled();
  assert.equal(f.setup.snapshot().deployment, "provisioned");
  f.provision.digest = async () => "new-source";
  await f.setup.review();
  assert.equal(f.setup.snapshot().deployment, "update_pending");
});

test("managed default provisions without HNS or community provider keys while release and discovery stay pending", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.secrets.read = async () => {
    reads++;
    throw new Error("Managed mode must not request provider keys");
  };
  await f.setup.configure({ ...settings, moderationMode: "pirate", tld: "" });
  assert.equal(f.setup.snapshot().settings?.projectId, "");
  await assert.rejects(
    () => f.setup.saveSecrets(credentials),
    /managed operator/,
  );
  await f.setup.review();
  await f.setup.deploy({ planId: f.setup.snapshot().plan!.id });
  await f.setup.settled();
  assert.equal(reads, 0);
  assert.equal(f.calls(), 1);
  assert.equal(f.setup.snapshot().deployment, "provisioned");
  assert.equal(f.setup.snapshot().readiness.at(-1)?.state, "not_ready");
  assert.equal(
    f.setup
      .snapshot()
      .readiness.find((item) => item.title.includes("discovery"))?.state,
    "unverified",
  );
});
test("a completed apply with pending HTTPS retries only the health probe", async (t) => {
  let applies = 0,
    probes = 0;
  const f = await fixture(t, {
    async deploy() {
      applies++;
      throw new HealthPending();
    },
    async health() {
      probes++;
    },
  });
  await f.setup.configure({ ...settings, moderationMode: "pirate" });
  await f.setup.review();
  const planId = f.setup.snapshot().plan!.id;
  await f.setup.deploy({ planId });
  await f.setup.settled();
  assert.equal(f.setup.snapshot().deployment, "health_pending");
  await f.setup.deploy({ planId });
  await f.setup.settled();
  assert.equal(f.setup.snapshot().deployment, "provisioned");
  assert.equal(applies, 1);
  assert.equal(probes, 1);
});
