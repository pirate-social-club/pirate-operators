import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
// Establish a module-wide deny rule before loading any draft code. A missed
// injection must throw locally; it can never reach timeout, Alchemy or a shell.
const childProcess = createRequire(import.meta.url)("node:child_process");
let forbiddenChildCalls = 0;
for (const method of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
])
  childProcess[method] = () => {
    forbiddenChildCalls++;
    throw Error("real_child_process_forbidden");
  };
syncBuiltinESMExports();
const { fixture, setup } = await import("./study-operator-fixture.ts");
const { runOperator } = await import("../harness/study-operator-runner.ts");
const { operatorScope } = await import("../harness/study-operator-private.ts");
const { main } = await import("../harness/study-operator-release.ts");
const { operatorPlan } = await import("../harness/study-operator-profile.ts");
const { operatorEnvironment, managedOperatorReferences } = await import(
  "../harness/study-operator-live.ts"
);
const {
  operatorDeployCommand,
  redactOperatorOutput,
  deployOperatorOnce,
  assertOperatorChildEnvironment,
} = await import("../harness/study-operator-execution.ts");
const now = Date.parse("2026-11-07T08:00:00.000Z");
function childEnv(p = fixture()) {
  return operatorEnvironment(
    p,
    { PATH: "/fixture", HOME: "/fixture-home" },
    "fixture-cloud",
    {
      password: "fixture-state-password",
      speech: "fixture-speech",
      operatorKey: `0x${"11".repeat(32)}`,
    },
  );
}
test("actual CLI default plan and help never import the live adapter", async () => {
  let reads = 0,
    loads = 0;
  const output: string[] = [];
  const io = {
    readPublic: async () => {
      reads++;
      return fixture();
    },
    loadLive: async () => {
      loads++;
      throw Error("live import forbidden");
    },
    print: (s: string) => output.push(s),
  };
  await main(["--profile", "synthetic.json"], io);
  assert.equal(reads, 1);
  assert.equal(loads, 0);
  assert.equal(JSON.parse(output[0]!).executionReady, false);
  await main(["--help"], io);
  assert.equal(reads, 1);
  assert.equal(loads, 0);
});
test("actual CLI invalid execute hash and conflicting modes stop before live imports", async () => {
  let loads = 0,
    reads = 0;
  const io = {
    readPublic: async () => {
      reads++;
      return fixture();
    },
    loadLive: async () => {
      loads++;
      throw Error("forbidden");
    },
  };
  await assert.rejects(
    main(
      [
        "--profile",
        "synthetic.json",
        "--execute",
        "--expected-profile",
        "wrong",
      ],
      io,
    ),
    /profile_not_reviewed/,
  );
  await assert.rejects(
    main(["--profile", "synthetic.json", "--execute", "--preflight"], io),
    /conflicting_modes/,
  );
  assert.equal(loads, 0);
  assert.equal(reads, 1);
});
test("actual environment builder selects V3 and retains all limits and current activation account without ambient credential inheritance", () => {
  const p = fixture(),
    key = `0x${"11".repeat(32)}` as const,
    secrets = {
      password: "fixture-state-password",
      speech: "fixture-speech",
      operatorKey: key,
    },
    activation = "0x" + "22".repeat(20);
  const env = operatorEnvironment(
    p,
    {
      PATH: "/fixture",
      HOME: "/fixture-home",
      LEARNING_PROFILE: "malicious",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
    },
    "fixture-cloud",
    secrets,
    activation,
  );
  assert.equal(env.LEARNING_PROFILE, "pirate-learning-testnet-v3");
  assert.equal(env.LEARNING_RESULTS_CONTRACT, p.selection.resultsV2.contract);
  assert.equal(
    env.LEARNING_RESULTS_V3_CONTRACT,
    p.selection.resultsV3.contract,
  );
  assert.equal(env.LEARNING_SPONSOR_CAP_WEI, "500000000000000");
  assert.equal(env.LEARNING_SPEECH_DAILY_LIMIT, "0");
  assert.equal(env.LEARNING_APPROVED_ACTIVATION_ACCOUNT, activation);
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
  assert.equal(managedOperatorReferences.speech.key, "ELEVENLABS_API_KEY");
  assert.equal(
    managedOperatorReferences.state.key,
    "PIRATE_WIZARD_STATE_PASSWORD",
  );
  const bad = fixture();
  bad.selection.chainId = 1 as any;
  assert.throws(() => operatorEnvironment(bad, {}, "fixture", secrets));
});
test("actual command builder keeps original operator cwd and fixed retained stage with bounded timeout", () => {
  const p = fixture(),
    hash = operatorPlan(p).profileHash,
    command = operatorDeployCommand(p, hash, now);
  assert.equal(command.executable, "/usr/bin/timeout");
  assert.ok(
    command.cwd.endsWith("/pirate-learning-results-testnet-20261106/alchemy"),
  );
  assert.deepEqual(command.args.slice(-4), [
    "--stage",
    "testnet",
    "--no-input",
    "--yes",
  ]);
  assert.deepEqual(command.args.slice(-6, -4), ["--env-file", "/dev/null"]);
  assert.equal(command.args[2], "300s");
  assert.ok(!command.args.includes("setup"));
  assert.throws(
    () => operatorDeployCommand(p, hash, now + 400000),
    /window_expired/,
  );
});
test("redaction handles overlapping secrets literally", () => {
  assert.equal(
    redactOperatorOutput("tokenABC token key? $special", [
      "token",
      "tokenABC",
      "key?",
      "$special",
    ]),
    "[redacted] [redacted] [redacted] [redacted]",
  );
});
function fakeSpawn(
  chunks: Buffer[],
  code: number | null = 0,
  startError = false,
) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const calls: any[] = [];
  return {
    child,
    calls,
    spawn: ((...args: any[]) => {
      calls.push(args);
      queueMicrotask(() => {
        if (startError) child.emit("error", new Error("fixture-start-failure"));
        else {
          for (const chunk of chunks) child.stdout.emit("data", chunk);
          child.emit("close", code);
        }
      });
      return child;
    }) as any,
  };
}
test("actual child adapter persists only redacted output and returns an opaque diagnostic ID", async () => {
  const p = fixture(),
    fake = fakeSpawn([
      Buffer.from("fixture-private-key fixture-state-password fixture-cloud"),
    ]);
  let captured: any,
    admitted = 0;
  const result = await deployOperatorOnce(
    p,
    operatorPlan(p).profileHash,
    childEnv(p),
    "fixture-state-password",
    ["fixture-private-key", "fixture-state-password", "fixture-cloud"],
    now,
    {
      spawn: fake.spawn,
      assertDispatch: async () => {
        admitted++;
      },
      persistDiagnostic: async (value) => {
        captured = value;
        return "fixture-log.enc";
      },
    },
  );
  assert.equal(result.logId, "fixture-log.enc");
  assert.equal(captured.output, "[redacted] [redacted] [redacted]");
  assert.equal(captured.truncated, false);
  assert.equal(admitted, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0][2].env.CI, "true");
  assert.equal(forbiddenChildCalls, 0);
});
test("actual child truncation and spawn failure return unknown outcomes without success", async () => {
  const p = fixture(),
    hash = operatorPlan(p).profileHash;
  let captured: any;
  for (const fake of [
    fakeSpawn([Buffer.alloc(2 * 1024 * 1024 + 1)]),
    fakeSpawn([], null, true),
    fakeSpawn([], 124),
  ]) {
    await assert.rejects(
      deployOperatorOnce(
        p,
        hash,
        childEnv(p),
        "fixture-state-password",
        [],
        now,
        {
          spawn: fake.spawn,
          assertDispatch: async () => {},
          persistDiagnostic: async (value) => {
            captured = value;
            return "fixture.enc";
          },
        },
      ),
      /outcome_unknown/,
    );
    assert.ok(
      captured.truncated || captured.started === false || captured.code === 124,
    );
    assert.equal(fake.calls.length, 1);
  }
  assert.equal(forbiddenChildCalls, 0);
});
test("missing injection, unadmitted dispatch and incomplete or ambient environments never call the fake child", async () => {
  const p = fixture(),
    hash = operatorPlan(p).profileHash,
    fake = fakeSpawn([]);
  await assert.rejects(
    deployOperatorOnce(
      p,
      hash,
      childEnv(p),
      "fixture-state-password",
      [],
      now,
      undefined as any,
    ),
    /child_dependency_missing/,
  );
  await assert.rejects(
    deployOperatorOnce(
      p,
      hash,
      childEnv(p),
      "fixture-state-password",
      [],
      now,
      {
        spawn: fake.spawn,
        assertDispatch: async () => {
          throw Error("fixture-not-dispatched");
        },
      },
    ),
    /fixture-not-dispatched/,
  );
  for (const env of [
    {},
    { ...childEnv(p), CI: "false" },
    { ...childEnv(p), CLOUDFLARE_API_TOKEN: "" },
    { ...childEnv(p), AWS_SECRET_ACCESS_KEY: "ambient" },
  ])
    assert.throws(
      () => assertOperatorChildEnvironment(p, env, "fixture-state-password"),
      /child_environment/,
    );
  assert.equal(fake.calls.length, 0);
  assert.equal(forbiddenChildCalls, 0);
});
test("unreviewed public profile admits explicit cloud-plan after preservation but stops deploy before any port", async () => {
  const s = setup();
  s.profile.execution.reviewedPlanPath = null;
  s.profile.execution.reviewedPlanSha256 = null;
  const originalScope = operatorScope(s.profile);
  let plans = 0;
  s.ports.planOnly = async () => {
    plans++;
    s.calls.push("plan-only");
    return { receiptPath: "/synthetic/private/receipt.json" };
  };
  const initial = operatorPlan(s.profile);
  await assert.rejects(
    runOperator(s.profile, "execute", s.ports, initial.profileHash),
    /plan_review_missing/,
  );
  assert.equal(s.calls.length, 0);
  const result = await runOperator(
    s.profile,
    "cloud-plan",
    s.ports,
    initial.profileHash,
  );
  assert.equal(plans, 1);
  assert.ok("execution" in result);
  assert.match(result.execution, /no deploy dispatched/);
  assert.ok(s.calls.indexOf("preserve") < s.calls.indexOf("secrets"));
  assert.ok(!s.calls.includes("dispatched"));
  assert.ok(!s.calls.includes("apply"));
  s.profile.execution.reviewedPlanPath = "/synthetic/private/review.json";
  s.profile.execution.reviewedPlanSha256 = "0x" + "f".repeat(64);
  assert.equal(operatorScope(s.profile), originalScope);
  assert.notEqual(operatorPlan(s.profile).profileHash, initial.profileHash);
  assert.equal(forbiddenChildCalls, 0);
});
test("actual injected cloud-plan command can only capture plan and never selects deploy or approval flags", async () => {
  const p = fixture(),
    fake = fakeSpawn([Buffer.from("plan fixture-cloud")]);
  let saved: any;
  const result = await deployOperatorOnce(
    p,
    operatorPlan(p).profileHash,
    childEnv(p),
    "fixture-state-password",
    ["fixture-cloud"],
    now,
    {
      spawn: fake.spawn,
      operation: "plan",
      assertDispatch: async () => {},
      persistDiagnostic: async (v) => {
        saved = v;
        return "fixture-plan.enc";
      },
    },
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0][1][4], "plan");
  assert.ok(!fake.calls[0][1].includes("deploy"));
  assert.ok(!fake.calls[0][1].includes("--yes"));
  assert.equal(result.planOutput, "plan [redacted]");
  assert.equal(saved.output, "plan [redacted]");
  assert.equal(forbiddenChildCalls, 0);
});
