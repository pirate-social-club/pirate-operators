import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { operatorOptions } from "../server/operator.ts";

const password = "fixture-operator-state-password-not-for-real-use";
const token = "fixture-cloudflare-token-not-for-real-use";
const ambient = "fixture-ambient-value-must-not-be-forwarded";
const accountId = "a".repeat(32);
const projectId = "12345678-1234-1234-1234-123456789abc";
const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = join(root, "server/start-operator.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const settings = {
  name: "Operator fixture",
  slug: "operator-fixture",
  tld: "c22",
  accountId,
  subdomain: "fixture",
  projectId,
  environment: "staging",
  secretPath: "/communities/provider-fixture",

  cloudconvert: false,
  moderationMode: "independent",
};

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  behavior = "success",
) {
  const directory = await mkdtemp(join(tmpdir(), "wizard-operator-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "restored"),
    bin = join(directory, "bin");
  await mkdir(state, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  const setup = JSON.stringify({
    version: 1,
    revision: 3,
    settings,
    secretStoreSite: "https://app.infisical.com",
    secrets: [],
    deployment: "failed",
    attempted: true,
  });
  await writeFile(join(state, "setup.json"), setup, { mode: 0o600 });
  const infisicalTrace = join(directory, "infisical-trace.json");
  await writeFile(
    join(bin, "infisical"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(infisicalTrace)},JSON.stringify({args,env:Object.keys(process.env),cwd:process.cwd()}));
const command=args.slice(args.indexOf('--')+1);
process.execve(command[0],command,{...process.env,
  PIRATE_WIZARD_STATE_PASSWORD:${JSON.stringify(behavior === "missing-password" ? "" : password)},
  CLOUDFLARE_API_TOKEN:${JSON.stringify(behavior === "missing-token" ? "" : token)},
  OPENAI_API_KEY:${JSON.stringify(ambient)},PIRATE_WIZARD_STATE_DIR:'/wrong',
  INFISICAL_SITE_URL:'https://wrong.invalid',PIRATE_WIZARD_PORT:'9'});
`,
    { mode: 0o700 },
  );
  const cfTrace = join(directory, "cf-trace.json"),
    login = join(directory, "default.json");
  await writeFile(
    join(bin, "cf"),
    `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(cfTrace)},JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env),cwd:process.cwd()}));
fs.writeFileSync(${JSON.stringify(login)},JSON.stringify({oauth_token:${JSON.stringify(token)},expiration_time:new Date(Date.now()+${behavior === "expired" ? -1000 : 1800000}).toISOString()}),{mode:0o600});
if (${JSON.stringify(behavior)}==='error') { console.error(${JSON.stringify(token)});process.exit(1); }
console.log(JSON.stringify({authenticated:${behavior !== "unauthenticated"},tokenValid:true,
authSource:'OAuth token from '+${JSON.stringify(login)},accounts:[{id:${JSON.stringify(behavior === "wrong-account" ? "b".repeat(32) : accountId)}}]}));
`,
    { mode: 0o700 },
  );
  const args = [
    "--state-dir",
    state,
    "--runner-secrets-path",
    "/communities/operator-fixture-runner",
  ];
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    OPENAI_API_KEY: ambient,
    CLOUDFLARE_API_TOKEN: ambient,
    PIRATE_WIZARD_STATE_PASSWORD: ambient,
    INFISICAL_TOKEN: ambient,
    INFISICAL_CLIENT_SECRET: ambient,
  };
  return { directory, state, args, env, setup, infisicalTrace, cfTrace };
}

test("operator configuration requires explicit private state and a separate runner scope", async (t) => {
  const f = await fixture(t);
  const options = await operatorOptions(f.args, f.env);
  assert.equal(options.mode, "api-token");
  assert.equal(options.projectId, projectId);
  assert.equal(options.environment, "staging");
  for (const args of [
    [],
    ["--state-dir", "relative"],
    [...f.args, "--cloudflare-auth", "other"],
    ["--state-dir", f.state, "--runner-secrets-path", settings.secretPath],
    [...f.args, "--infisical-site", "https://wrong.invalid"],
    [...f.args, "--port", "0"],
  ])
    await assert.rejects(() => operatorOptions(args, f.env));
  await writeFile(join(f.state, "runner.lock"), "1\n", { mode: 0o600 });
  await assert.rejects(() => operatorOptions(f.args, f.env), /locked/);
  assert.equal(await readFile(join(f.state, "runner.lock"), "utf8"), "1\n");
});

async function start(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", tsx, launcher, ...f.args, ...args],
    { cwd: root, env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const finished = new Promise<number | null>((done) =>
    child.once("close", done),
  );
  return { child, finished, output: () => output };
}

test("operator --check is nonsecret and does not authenticate, start or mutate state", async (t) => {
  const f = await fixture(t),
    run = await start(f, ["--check"]);
  assert.equal(await run.finished, 0);
  assert.equal(JSON.parse(run.output()).directory, f.state);
  await assert.rejects(() => access(f.infisicalTrace));
  await assert.rejects(() => access(join(f.state, "runner.lock")));
  assert.equal(await readFile(join(f.state, "setup.json"), "utf8"), f.setup);
  assert.ok(!run.output().includes(ambient));
});

for (const mode of ["api-token", "cf-login"]) {
  test(`actual launcher starts the real runner with ${mode} and keeps credentials out of argv/output`, async (t) => {
    const f = await fixture(t);
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((done) => probe.close(() => done()));
    const run = await start(f, [
      "--cloudflare-auth",
      mode,
      "--port",
      String(port),
    ]);
    t.after(async () => {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      await run.finished;
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/state`, {
          signal: AbortSignal.timeout(100),
        });
      } catch {}
      if (response?.ok || run.child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(response?.ok, run.output());
    const state = await response.json();
    assert.equal(state.capabilities.cloudflare, true);
    assert.equal(state.capabilities.stateProtection, true);
    assert.equal(state.deployment, "failed");
    assert.equal(state.settings.moderationMode, "independent");
    assert.equal(await readFile(join(f.state, "setup.json"), "utf8"), f.setup);
    const trace = JSON.parse(await readFile(f.infisicalTrace, "utf8"));
    assert.equal(trace.cwd, f.state);
    for (const flag of [
      "--include-imports=false",
      "--expand=false",
      "--recursive=false",
      "--secret-overriding=false",
    ])
      assert.ok(trace.args.includes(flag));
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "PIRATE_WIZARD_STATE_PASSWORD",
      "OPENAI_API_KEY",
      "INFISICAL_TOKEN",
      "INFISICAL_CLIENT_SECRET",
    ])
      assert.ok(!trace.env.includes(name));
    if (mode === "cf-login") {
      const cf = JSON.parse(await readFile(f.cfTrace, "utf8"));
      assert.deepEqual(cf.args, ["auth", "whoami", "--profile", "default"]);
      assert.equal(cf.cwd, f.state);
      assert.ok(!cf.env.includes("PIRATE_WIZARD_STATE_PASSWORD"));
      assert.ok(!cf.env.includes("CLOUDFLARE_API_TOKEN"));
    } else await assert.rejects(() => access(f.cfTrace));
    for (const value of [password, token, ambient]) {
      assert.ok(!JSON.stringify(trace.args).includes(value));
      assert.ok(!run.output().includes(value));
      assert.ok(!JSON.stringify(state).includes(value));
    }
    // The process replacements retain the runner PID for graceful shutdown.
    const pid = Number(await readFile(join(f.state, "runner.lock"), "utf8"));
    assert.equal(pid, run.child.pid);
    if (process.platform === "linux") {
      const names = (await readFile(`/proc/${pid}/environ`, "utf8"))
        .split("\0")
        .map((entry) => entry.split("=", 1)[0]);
      for (const name of [
        "OPENAI_API_KEY",
        "INFISICAL_TOKEN",
        "INFISICAL_CLIENT_SECRET",
      ])
        assert.ok(!names.includes(name));
    }
    run.child.kill("SIGTERM");
    assert.equal(await run.finished, 0);
    await assert.rejects(() => access(join(f.state, "runner.lock")));
  });
}

test("launcher refuses failed/expired/wrong-account cf sessions and missing injected secrets without leaking CLI output", async (t) => {
  for (const behavior of [
    "unauthenticated",
    "expired",
    "wrong-account",
    "error",
    "missing-password",
    "missing-token",
  ]) {
    const f = await fixture(t, behavior);
    const run = await start(f, [
      "--cloudflare-auth",
      behavior === "missing-token" ? "api-token" : "cf-login",
    ]);
    assert.equal(await run.finished, 1, behavior);
    for (const value of [password, token, ambient])
      assert.ok(!run.output().includes(value));
    await assert.rejects(() => access(join(f.state, "runner.lock")));
    assert.equal(await readFile(join(f.state, "setup.json"), "utf8"), f.setup);
  }
});
