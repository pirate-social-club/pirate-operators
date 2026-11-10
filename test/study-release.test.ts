import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  studyReleasePlan,
  studyReleaseSelection,
  retainedResultsV2,
  retainedLearningController,
} from "../harness/study-release-profile.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import {
  learningContractBindings,
  applicationLearningBindings,
} from "../apps/community-wizard/infra/learning-bindings.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import { writeApplicationInfrastructure } from "../harness/community-infrastructure.ts";

test("public Study selection never implies deployment readiness or replaces retained resources", async () => {
  const raw = selectionFixture(),
    before = JSON.stringify(raw),
    plan = studyReleasePlan(raw);
  assert.equal(plan.executionReady, false);
  assert.deepEqual(plan.effects, {
    networkRequests: 0,
    privateKeysRead: 0,
    transactions: 0,
    resourceChanges: 0,
  });
  assert.equal(plan.operator.worker, "pirate-learning-testnet-v2");
  assert.equal(plan.operator.speechDailyLimit, 0);
  assert.ok(
    plan.order.findIndex((s) => s.startsWith("Deploy app")) <
      plan.order.findIndex((s) => s.startsWith("Only then")),
  );
  const old = await learningCommunityProfile(),
    next = await learningCommunityProfile(studyReleaseSelection(raw));
  assert.equal(next.contract, old.contract);
  assert.equal(next.operatorWorker, old.operatorWorker);
  assert.deepEqual(next.providerCredential, old.providerCredential);
  assert.equal(next.speechDailyCalls, 0);
  assert.equal(next.historyRetentionDays, 30);
  assert.equal("studyContract" in old, false);
  assert.equal(
    "studyContract" in next && next.studyContract,
    raw.resultsV3.contract,
  );
  assert.equal(JSON.stringify(raw), before);
});

for (const [name, mutate] of Object.entries<(p: any) => void>({
  mainnet: (p) => {
    p.chainId = 4326;
  },
  otherCommunity: (p) => {
    p.communityId = `0x${"1".repeat(64)}`;
  },
  otherController: (p) => {
    p.controller = `0x${"1".repeat(40)}`;
  },
  retainedTarget: (p) => {
    p.resultsV2.contract = p.resultsV3.contract;
  },
  sameTargets: (p) => {
    p.resultsV3.contract = p.resultsV2.contract;
  },
  zeroTarget: (p) => {
    p.resultsV3.contract = `0x${"0".repeat(40)}`;
  },
  zeroCode: (p) => {
    p.resultsV3.codeHash = `0x${"0".repeat(64)}`;
  },
  oldDisclosure: (p) => {
    p.resultsV3.publicityPolicy = `0x${"5".repeat(64)}`;
  },
  credential: (p) => {
    p.privateKey = "forbidden";
  },
  newWorker: (p) => {
    p.resultsV3.worker = "new-worker";
  },
  customRpc: (p) => {
    p.rpc = "https://invalid.example";
  },
  escapingPlan: (p) => {
    p.reviewedUpdate.previousPlanPath = "docs/deployments/../../secret.json";
  },
  noResult: (p) => {
    p.reviewedUpdate.expectedResultSha256 = null;
  },
}))
  test(`Study release selection refuses ${name}`, () => {
    const p = selectionFixture();
    mutate(p);
    assert.throws(() => studyReleaseSelection(p), /study_release_/);
  });

test("explicit V3 environment binds both targets while default V2 and app stay unchanged", () => {
  const p = selectionFixture(),
    old = { LEARNING_RESULTS_CONTRACT: p.resultsV2.contract };
  assert.deepEqual(learningContractBindings(old), {
    OPERATOR_PROFILE: "pirate-karaoke-testnet-v2",
    RESULTS_V2_CONTRACT: p.resultsV2.contract,
  });
  assert.deepEqual(applicationLearningBindings({}), {});
  const env = {
    ...old,
    LEARNING_PROFILE: "pirate-learning-testnet-v3",
    LEARNING_RESULTS_V3_CONTRACT: p.resultsV3.contract,
  };
  assert.deepEqual(learningContractBindings(env), {
    OPERATOR_PROFILE: env.LEARNING_PROFILE,
    RESULTS_V2_CONTRACT: old.LEARNING_RESULTS_CONTRACT,
    RESULTS_V3_CONTRACT: p.resultsV3.contract,
  });
  assert.deepEqual(applicationLearningBindings(env), {
    STUDY_RESULTS_V3_CONTRACT: p.resultsV3.contract,
  });
  for (const broken of [
    { ...old, LEARNING_RESULTS_V3_CONTRACT: p.resultsV3.contract },
    { ...env, LEARNING_PROFILE: "unknown" },
    { ...env, LEARNING_RESULTS_V3_CONTRACT: p.resultsV2.contract },
    { ...env, LEARNING_RESULTS_V3_CONTRACT: undefined },
    { ...env, LEARNING_RESULTS_CONTRACT: undefined },
    { ...env, LEARNING_SPEECH_DAILY_LIMIT: "10" },
  ]) {
    assert.throws(() => learningContractBindings(broken), /binding_invalid/);
    assert.throws(() => applicationLearningBindings(broken), /binding_invalid/);
  }
});

test("packaged Alchemy app resolves its copied bindings outside the source checkout", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pirate-study-infrastructure-"),
  );
  try {
    await writeApplicationInfrastructure(directory);
    const result = await build({
      entryPoints: [join(directory, "alchemy.run.ts")],
      bundle: true,
      write: false,
      packages: "external",
      platform: "node",
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile!.inputs).map((p) => resolve(p));
    assert.equal(inputs.length, 4);
    assert.ok(inputs.every((p) => p.startsWith(directory + "/")));
    assert.ok(inputs.includes(join(directory, "learning-bindings.ts")));
    assert.deepEqual(
      await readFile(join(directory, "learning-bindings.ts")),
      await readFile("apps/community-wizard/infra/learning-bindings.ts"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public preparation CLI is bounded, needs no credentials and has no execution flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirate-study-release-")),
    run = promisify(execFile),
    script = resolve("harness/study-release.ts");
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: join(directory, "absent-home"),
      TMPDIR: directory,
    };
    const help = await run(process.execPath, [script], { cwd: directory, env });
    assert.match(help.stdout, /Public preparation only/);
    await writeFile(
      join(directory, "public.json"),
      JSON.stringify(selectionFixture()),
    );
    const result = await run(
      process.execPath,
      [script, "--profile", "public.json"],
      { cwd: directory, env },
    );
    assert.equal(JSON.parse(result.stdout).executionReady, false);
    assert.deepEqual(await readdir(directory), ["public.json"]);
    await assert.rejects(
      run(process.execPath, [script, "--deploy"], { cwd: directory, env }),
    );
    await writeFile(join(directory, "oversize.json"), " ".repeat(65537));
    await assert.rejects(
      run(process.execPath, [script, "--profile", "oversize.json"], {
        cwd: directory,
        env,
      }),
    );
    const files = await readdir(directory);
    assert.deepEqual(files.sort(), ["oversize.json", "public.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public preparation graph excludes managed credentials, signing journals and deploy runners", async () => {
  const result = await build({
    entryPoints: ["harness/study-release.ts"],
    bundle: true,
    write: false,
    packages: "external",
    platform: "node",
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(
    Object.keys(result.metafile!.inputs).filter((p) =>
      /infisical|private-json|controller-inventory|dispatch-catalog|learning-testnet-stack|community-release\.ts/.test(
        p,
      ),
    ),
    [],
  );
  const v2 = JSON.parse(
    await readFile(
      "docs/deployments/learning-results-testnet-20261106.contract.json",
      "utf8",
    ),
  );
  assert.equal(v2.learningResults, retainedResultsV2.contract);
  assert.equal(v2.codeHash, retainedResultsV2.codeHash);
  assert.equal(v2.controller, retainedLearningController);
});
