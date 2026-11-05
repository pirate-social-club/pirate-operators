import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPlan, profileFrom, canonical, digest } from "../model.ts";
import { withJournal, Store } from "../journal.ts";
import { Context } from "../http.ts";
import { main } from "../run.ts";
import { authenticatedSdk, createVault } from "../vault.ts";

import {
  profile,
  intent,
  memoryVault,
  state,
} from "./provider-setup-fixtures.ts";
test("provider profiles reject secrets/unknown settings, nested secret scopes and invalid catalogs", () => {
  assert.throws(
    () => profileFrom({ ...profile, apiKey: "must-not-enter-plan" }),
    /unknown_profile/,
  );
  assert.throws(
    () =>
      profileFrom({
        ...profile,
        vault: {
          ...profile.vault,
          runtimePath: "/onboarding/bootstrap/runtime",
        },
      }),
    /separate_secret/,
  );
  assert.throws(() => profileFrom({ ...profile, musicBucketId: 0 }));
  assert.equal(createPlan(profile, intent).names.filebase.length <= 63, true);
});
test("real CLI entry initializes and reopens without credentials or external effects", async () => {
  const parent = await mkdtemp(join(tmpdir(), "provider-cli-test-")),
    directory = join(parent, "state"),
    path = join(parent, "profile.json");
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
  const initial = await main([
    "init",
    "--profile",
    path,
    "--state-dir",
    directory,
  ]);
  const dry = await main(["provision", "--state-dir", directory]);
  assert.equal(dry?.execution, "none");
  assert.equal(initial?.planDigest, dry?.planDigest);
  await assert.rejects(
    main([
      "provision",
      "--execute",
      "--approve",
      "wrong",
      "--state-dir",
      directory,
    ]),
    /exact_plan/,
  );
  await assert.rejects(
    main(["init", "--profile", path, "--state-dir", directory]),
    /already_exists/,
  );
});
test("journal locks refuse simultaneous writers and reject symlink or repository state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-lock-test-"));
  await withJournal(directory, async () => {
    await assert.rejects(
      withJournal(directory, async () => {}),
      /runner_locked/,
    );
  });
  await withJournal(directory, async () => {});
  const link = directory + "-link";
  await symlink(directory, link);
  await assert.rejects(
    withJournal(link, async () => {}),
    /symlink/,
  );
  await mkdir(join(directory, ".git"));
  await assert.rejects(
    withJournal(join(directory, "nested"), async () => {}),
    /inside_repository/,
  );
});
test("lost responses reconcile before marking success and never repeat a create or paid probe", async () => {
  const store = await state();
  let creates = 0;
  await assert.rejects(
    store.once("test.create", async () => {
      creates++;
      throw Error("lost");
    }),
  );
  const reopened = new Store(store.directory);
  await reopened.load();
  await reopened.once(
    "test.create",
    async () => {
      creates++;
      return {};
    },
    async () => ({ resourceId: 1 }),
  );
  await reopened.once("test.create", async () => {
    creates++;
    return {};
  });
  assert.equal(creates, 1);
  await assert.rejects(
    store.once("test.paid", async () => {
      throw Error("timeout");
    }),
  );
  await assert.rejects(
    store.once("test.paid", async () => ({})),
    /uncertain_test_paid/,
  );
});
test("HTTP boundary refuses other origins, redirects and oversized or sensitive error responses", async () => {
  const store = await state();
  let calls = 0;
  const ctx = new Context(store, memoryVault(), async (request) => {
    calls++;
    assert.equal(request.redirect, "error");
    return new Response("secret-bearing error", { status: 401 });
  });
  await assert.rejects(ctx.json("https://attacker.invalid"), /unapproved/);
  assert.equal(calls, 0);
  await assert.rejects(
    ctx.json("https://api.openai.com/v1/organization/projects"),
    (error) => {
      assert.equal((error as Error).message, "provider_http_401");
      return true;
    },
  );
  const large = new Context(
    store,
    memoryVault(),
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(
    large.json("https://api.openai.com/v1/organization/projects"),
    /too_large/,
  );
  const exploding = new Context(store, memoryVault(), async () => {
    throw Error("raw-secret-token");
  });
  await assert.rejects(
    exploding.json("https://api.openai.com/v1/organization/projects"),
    /provider_request_uncertain/,
  );
});
test("Infisical authentication pins a verified profile and withholds failed CLI output", async () => {
  const token =
    "eyJ0eXAiOiJKV1QifQ." +
    Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString(
      "base64url",
    ) +
    ".signature";
  const calls: string[][] = [];
  await authenticatedSdk(async (args) => {
    calls.push(args);
    return args[0] === "login"
      ? JSON.stringify({
          sessions: [
            {
              principalType: "user",
              status: "authenticated",
              verification: { state: "verified" },
              domain: "https://app.infisical.com/api",
              profile: "test-profile",
            },
          ],
        })
      : token;
  });
  assert.deepEqual(calls[1].slice(-2), ["--profile", "test-profile"]);
  await assert.rejects(
    authenticatedSdk(async () => {
      throw Error(token);
    }),
    /verified_login_required/,
  );
});
test("runtime vault writes reconcile and cannot overwrite or accept administrative keys", async () => {
  const values = new Map<string, string>();
  const folders = new Set<string>();
  const scopes: Record<string, unknown>[] = [];
  const sdk = {
    folders: () => ({
      listFolders: async (s: Record<string, unknown>) =>
        [...folders]
          .filter((p) => p.startsWith(String(s.path) + "/") || s.path === "/")
          .map((p) => ({ name: p.split("/").pop() })),
      create: async (s: Record<string, unknown>) => {
        folders.add(`${s.path === "/" ? "" : s.path}/${s.name}`);
      },
    }),
    secrets: () => ({
      listSecrets: async (s: Record<string, unknown>) => {
        scopes.push(s);
        return { secrets: [...values].map(([secretKey]) => ({ secretKey })) };
      },
      getSecret: async (s: Record<string, unknown>) => ({
        secretValue: values.get(String(s.secretName)),
      }),
      createSecret: async (name: string, s: Record<string, unknown>) => {
        values.set(name, String(s.secretValue));
        throw Error("response lost");
      },
    }),
  } as unknown as Parameters<typeof createVault>[1];
  const vault = await createVault(createPlan(profile, intent), sdk);
  await vault.put("OPENAI_API_KEY", "runtime-test-key");
  await vault.put("OPENAI_API_KEY", "runtime-test-key");
  await assert.rejects(vault.put("OPENAI_API_KEY", "another-key"), /conflict/);
  await assert.rejects(
    vault.put("OPENAI_ADMIN_KEY", "admin-test-key"),
    /name_refused/,
  );
  assert(
    scopes.every(
      (s) => s.includeImports === false && s.expandSecretReferences === false,
    ),
  );
  assert(
    scopes
      .filter((s) => String(s.secretPath).includes("runtime"))
      .every((s) => s.secretPath === `/onboarding/runtime/${intent}`),
  );
});
test("actual CLI failure output hides child-process stderr and provider environment values", async () => {
  const store = await state(),
    bin = join(store.directory, "bin");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(
    join(bin, "infisical"),
    '#!/bin/sh\nprintf "untrusted-secret-stderr" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const result = await promisify(execFile)(
    process.execPath,
    [
      new URL("../run.ts", import.meta.url).pathname,
      "provision",
      "--state-dir",
      store.directory,
      "--execute",
      "--approve",
      digest(canonical(store.journal!.plan)),
    ],
    {
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        OPENAI_ADMIN_KEY: "ambient-key-not-accepted",
      },
    },
  ).then(
    () => undefined,
    (e) => e,
  );
  assert(result);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "infisical_verified_login_required",
  });
});
