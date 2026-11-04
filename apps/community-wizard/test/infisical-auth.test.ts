import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  infisicalAuth,
  cliRunner,
  siteOrigin,
} from "../server/infisical-auth.ts";

const token = (exp = Math.floor(Date.now() / 1000) + 3600) =>
  `fixture.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const session = {
  principalType: "user",
  status: "authenticated",
  domain: "https://infisical.invalid",
  profile: "fixture-profile",
  verification: { state: "verified" },
};

test("CLI auth validates instance and pins its profile without exposing a session", async () => {
  const calls: string[][] = [];
  const auth = infisicalAuth(
    { INFISICAL_SITE_URL: session.domain },
    async (args) => {
      calls.push(args);
      return args[0] === "login"
        ? JSON.stringify({ sessions: [session] })
        : token();
    },
  );
  await auth.client();
  assert.deepEqual(auth.connection, { mode: "cli", siteUrl: session.domain });
  assert.deepEqual(calls[1], [
    "user",
    "get",
    "token",
    "--plain",
    "--silent",
    "--domain",
    `${session.domain}/api`,
    "--profile",
    "fixture-profile",
  ]);
  assert.ok(!JSON.stringify(auth).includes(token()));
  assert.ok(!JSON.stringify(calls).includes(token()));
});

test("wrong instance/profile, expired, ambiguous and unverified sessions fail before reading a token", async () => {
  for (const sessions of [
    [],
    [session, session],
    [{ ...session, domain: "https://other.invalid" }],
    [{ ...session, status: "expired" }],
    [{ ...session, verification: { state: "unknown" } }],
    [{ ...session, profile: "other-profile" }],
    [{ ...session, principalType: "machineIdentity" }],
  ]) {
    let calls = 0;
    const auth = infisicalAuth(
      {
        INFISICAL_SITE_URL: session.domain,
        INFISICAL_PROFILE: "fixture-profile",
      },
      async () => {
        calls++;
        return JSON.stringify({ sessions });
      },
    );
    await assert.rejects(auth.client, /active Infisical CLI login/);
    assert.equal(calls, 1);
  }
  for (const response of [
    "not-json",
    "fixture-secret-token",
    token(1),
    `${token()}\nextra-output`,
  ]) {
    const auth = infisicalAuth(
      { INFISICAL_SITE_URL: session.domain },
      async (args) =>
        args[0] === "login"
          ? JSON.stringify({ sessions: [session] })
          : response,
    );
    await assert.rejects(
      auth.client,
      (error: Error) => !error.message.includes(response),
    );
  }
});

test("machine auth remains explicit and partial credentials do not fall back to CLI", async () => {
  let calls = 0;
  const auth = infisicalAuth(
    { INFISICAL_CLIENT_ID: "fixture-client" },
    async () => {
      calls++;
      return "";
    },
  );
  await assert.rejects(auth.client, /both Infisical machine credentials/);
  assert.equal(calls, 0);
  assert.equal(auth.connection.mode, "machine");
  assert.throws(() => infisicalAuth({ INFISICAL_AUTH_MODE: "other" }));
  for (const value of [
    "http://example.invalid",
    "https://user:pass@example.invalid",
    "https://example.invalid/path",
    "https://example.invalid?token=fixture",
  ])
    assert.throws(() => siteOrigin(value));
  assert.equal(siteOrigin(`${session.domain}/api`), session.domain);
});

test("real CLI subprocess is bounded, shell-free and excludes provider credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-cli-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "infisical");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify({args:process.argv.slice(2),env:process.env}));
if (process.argv.includes('fail')) { console.error('fixture-provider-secret'); process.exit(1); }
if (process.argv.includes('large')) process.stdout.write('x'.repeat(70000));
else process.stdout.write('fixture-output');
`,
    { mode: 0o700 },
  );
  const run = cliRunner({
    PATH: directory,
    HOME: directory,
    CLOUDFLARE_API_TOKEN: "fixture-provider-secret",
    INFISICAL_TOKEN: "fixture-user-token",
  });
  assert.equal(await run(["literal;$(command)"]), "fixture-output");
  const observed = JSON.parse(
    await readFile(join(directory, "observed.json"), "utf8"),
  );
  assert.deepEqual(observed.args, ["literal;$(command)"]);
  assert.equal(observed.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(observed.env.INFISICAL_TOKEN, undefined);
  assert.equal(observed.env.INFISICAL_DISABLE_TELEMETRY, "1");
  for (const args of [["fail"], ["large"]])
    await assert.rejects(
      () => run(args),
      (error: Error) =>
        !error.message.includes("fixture-provider-secret") &&
        !error.message.includes("xxxx"),
    );
});
