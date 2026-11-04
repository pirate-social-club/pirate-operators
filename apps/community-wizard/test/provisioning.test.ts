import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  cp,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { State, type CreatedResourceState } from "alchemy/State";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { encryptedLocalState } from "../infra/encrypted-state.ts";
import { unseal } from "../infra/protected-data.ts";
import { waitForHealth, HealthPending } from "../server/health.ts";
import {
  runWithDiagnostics,
  DeploymentFailure,
} from "../server/diagnostics.ts";
import { inspectPrivateFiles } from "../server/state-inspection.ts";

const password = "fixture-state-password-for-isolated-tests-only";
test("actual Alchemy local store encrypts resource/output files and restores at another path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wizard-protected-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PIRATE_WIZARD_STATE_PASSWORD;
  process.env.PIRATE_WIZARD_STATE_PASSWORD = password;
  t.after(() => {
    if (previous === undefined) delete process.env.PIRATE_WIZARD_STATE_PASSWORD;
    else process.env.PIRATE_WIZARD_STATE_PASSWORD = previous;
  });
  const source = join(root, "first", ".alchemy"),
    restored = join(root, "restored", ".alchemy");
  const store = async (path: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const make = yield* State;
        return yield* make;
      }).pipe(
        Effect.provide(encryptedLocalState()),
        Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: path,
          dev: false,
          adopt: false,
        }),
      ),
    );
  const identity = { stack: "test-community", stage: "setup", fqn: "App" };
  const secret = "fixture-provider-key-must-not-appear-on-disk";
  const value: CreatedResourceState = {
    status: "created",
    resourceType: "fixture::Worker",
    namespace: undefined,
    fqn: "App",
    logicalId: "App",
    instanceId: "stable-instance",
    providerVersion: 1,
    downstream: [],
    bindings: [],
    props: { apiKey: Redacted.make(secret) },
    attr: { url: "https://fixture.example.workers.dev" },
  };
  const first = await store(source);
  await Effect.runPromise(first.set({ ...identity, value }));
  await Effect.runPromise(
    first.setOutput({ ...identity, value: { private: Redacted.make(secret) } }),
  );
  const files = await readdir(join(source, "state/test-community/setup"));
  assert.equal(files.length, 2);
  for (const file of files) {
    const path = join(source, "state/test-community/setup", file),
      text = await readFile(path, "utf8");
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("stable-instance"));
    assert.equal(JSON.parse(text).format, "pirate.protected-data/1");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await cp(source, restored, { recursive: true });
  const second = await store(restored),
    got = await Effect.runPromise(second.get(identity));
  assert.ok(got && "instanceId" in got);
  assert.equal(got.instanceId, "stable-instance");
  assert.equal(Redacted.value(got.props!.apiKey), secret);
  assert.deepEqual(await Effect.runPromise(second.list(identity)), ["App"]);
  const output = await Effect.runPromise(second.getOutput(identity));
  assert.ok(output && typeof output === "object" && "private" in output);
  assert.equal(
    Redacted.value(output.private as Redacted.Redacted<string>),
    secret,
  );
  process.env.PIRATE_WIZARD_STATE_PASSWORD = password + "-wrong";
  const wrong = await store(restored);
  await assert.rejects(
    () => Effect.runPromise(wrong.get(identity)),
    /could not be authenticated/,
  );
  process.env.PIRATE_WIZARD_STATE_PASSWORD = password;
  const path = join(
    restored,
    "state/test-community/setup",
    files.find((name) => name !== "__stack_output__.json")!,
  );
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 1;
  const movedOutput = await readFile(
    join(restored, "state/test-community/setup/__stack_output__.json"),
    "utf8",
  );
  for (const corrupt of [
    JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }),
    movedOutput,
  ]) {
    await writeFile(path, corrupt);
    await assert.rejects(
      () => Effect.runPromise(second.get(identity)),
      /could not be authenticated/,
    );
  }
  await writeFile(path, JSON.stringify(value));
  const plaintext = await store(restored);
  await assert.rejects(
    () => Effect.runPromise(plaintext.get(identity)),
    /Plaintext state is not accepted/,
  );
});
test("private command diagnostics preserve failures without plaintext secrets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-private-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = "fixture-output-token-not-for-public-logs";
  let failure: DeploymentFailure | undefined;
  try {
    await runWithDiagnostics(
      process.execPath,
      ["-e", "process.stderr.write(process.env.FIXTURE_VALUE);process.exit(7)"],
      {
        cwd: directory,
        env: { FIXTURE_VALUE: value },
        directory,
        password,
        phase: "deploy",
      },
    );
  } catch (error) {
    assert.ok(error instanceof DeploymentFailure);
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.exitCode, 7);
  assert.ok(!failure.message.includes(value));
  const file = join(directory, "diagnostics", failure.logId),
    encoded = await readFile(file, "utf8");
  assert.ok(!encoded.includes(value));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(unseal(encoded, password, `diagnostic:${failure.logId}`)).output,
    value,
  );
  await inspectPrivateFiles(directory, [value, password]);
  await writeFile(join(directory, "unexpected.json"), value);
  await assert.rejects(
    () => inspectPrivateFiles(directory, [value]),
    /Plaintext credential detected/,
  );
});
test("HTTPS polling tolerates DNS failure and stale receipts, then accepts only the bound deployment", async () => {
  let now = 0,
    calls = 0;
  await waitForHealth("https://fixture.example.workers.dev", "expected", {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    budgetMs: 10_000,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://fixture.example.workers.dev/health");
      assert.equal(init?.redirect, "error");
      calls++;
      if (calls === 1) throw new TypeError("fixture DNS delay");
      return Response.json({
        schema: "pirate.community-setup/1",
        planId: calls === 2 ? "stale" : "expected",
        infrastructure: "provisioned",
      });
    },
  });
  assert.equal(calls, 3);
  assert.equal(now, 3000);
});
test("HTTPS polling has a finite deadline and refuses oversized or wrong receipts", async () => {
  let now = 0,
    calls = 0;
  await assert.rejects(
    () =>
      waitForHealth("https://fixture.example.workers.dev", "expected", {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        budgetMs: 3000,
        fetch: async () => {
          calls++;
          return new Response("x".repeat(5000));
        },
      }),
    HealthPending,
  );
  assert.equal(now, 3000);
  assert.equal(calls, 2);
});
