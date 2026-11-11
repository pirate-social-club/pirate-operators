import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  communitySetupFrom,
  communitySetupPlan,
  learningSecretValues,
  type CommunitySetupV1,
  type LearningSecretName,
} from "../packages/community-setup/manifest.ts";
import {
  assertConnectedLearningLink,
  type ConnectedLearningLinkV1,
} from "../packages/community-setup/connected-learning.ts";
import { createSetup } from "../apps/community-wizard/server/setup.ts";
import { createWizardServer } from "../apps/community-wizard/server/http.ts";
import type { LearningSecretStore } from "../apps/community-wizard/server/learning-secrets.ts";
const bytes = (n: string, length: number) => `0x${n.repeat(length)}`;
function settings(n = "a"): CommunitySetupV1 {
  return {
    version: 1,
    communityId: bytes(n, 64),
    slug: `community-${n}`,
    accountId: n.repeat(32),
    origin: `https://community-${n}.example`,
    operatorOrigin: `https://learning-${n}.example`,
    chainId: 6343,
    resultsContract: bytes("1", 40),
    owner: bytes("2", 40),
    grader: bytes("3", 40),
    infisical: {
      projectId: `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`,
      environment: "dev",
      secretPath: `/communities/${n}/learning`,
    },
    limits: {
      sponsorWei: "1000000000000000000",
      gasPriceWei: "10000000000",
      gasLimit: "2000000",
      dataFeeWei: "0",
      activationTotalWei: "800000000000000000",
      activationAccountWei: "40000000000000000",
      activationAccounts: 20,
      speechDailyUnits: 200,
      websiteReservedUnits: 100,
      telegramDailyUnits: 0,
      perAccountDailyUnits: 20,
      providerMonthlyBudgetUsdCents: 1000,
    },
    telegram: { enabled: false, botId: "", generation: 1 },
    songs: [],
  };
}
const source = bytes("e", 64);
test("a second community has distinct resources, authority, secret scope and exact song revisions", () => {
  const a = communitySetupPlan(settings("a"), source);
  const second = settings("b");
  second.resultsContract = bytes("4", 40);
  second.owner = bytes("5", 40);
  second.grader = bytes("6", 40);
  second.songs = [
    { postId: bytes("7", 64), revision: 2, audioDigest: bytes("8", 64) },
  ];
  second.telegram = { enabled: true, botId: "1234", generation: 2 };
  second.limits.telegramDailyUnits = 50;
  const b = communitySetupPlan(second, source);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.resources.ownerAccountId, b.resources.ownerAccountId);
  assert.notEqual(a.resources.learningWorker, b.resources.learningWorker);
  assert.notEqual(
    a.secretReferences[0].secretPath,
    b.secretReferences[0].secretPath,
  );
  assert.equal(b.secretReferences[1].name, "TELEGRAM_BOT_TOKEN");
  assert.equal(b.operatorBindings.RESULTS_V4_CONTRACT, second.resultsContract);
  assert.equal(b.settings.songs[0].revision, 2);
  assert.equal(b.execution, "held_for_review");
  assert.equal(
    communitySetupPlan(JSON.parse(JSON.stringify(second)), source).id,
    b.id,
  );
  assert.throws(
    () => communitySetupFrom({ ...second, TELEGRAM_LOGIN_SECRET: "excluded" }),
    /unknown_or_missing/,
  );
  assert.throws(
    () => communitySetupFrom({ ...second, chainId: 1 }),
    /testnet_only/,
  );
  assert.throws(
    () =>
      communitySetupFrom({
        ...second,
        origin: "https://community.example/extra",
      }),
    /https_origin/,
  );
  assert.throws(
    () =>
      communitySetupFrom({
        ...second,
        limits: { ...second.limits, telegramDailyUnits: 101 },
      }),
    /speech_caps/,
  );
  assert.throws(
    () =>
      learningSecretValues(
        { TELEGRAM_BOT_TOKEN: "fixture-not-a-token" },
        false,
      ),
    /credential_field/,
  );
});
async function setupFixture() {
  const directory = await mkdtemp(join(tmpdir(), "community-setup-"));
  const records = new Map<
    string,
    Partial<Record<LearningSecretName, string>>
  >();
  let uncertain = false;
  const key = (s: CommunitySetupV1) =>
    `${s.infisical.projectId}:${s.infisical.environment}:${s.infisical.secretPath}`;
  const store: LearningSecretStore = {
    siteUrl: "https://secrets.example",
    check: async (s) =>
      Object.keys(records.get(key(s)) ?? {}) as LearningSecretName[],
    save: async (s, values) => {
      records.set(key(s), { ...records.get(key(s)), ...values });
      if (uncertain) throw Error("fixture-sensitive-provider-details");
      return Object.keys(records.get(key(s))!) as LearningSecretName[];
    },
  };
  let deployments = 0;
  const provisioner = {
    digest: async () => "e".repeat(64),
    health: async () => {},
    deploy: async () => {
      deployments++;
    },
  };
  const moderation = { save: async () => [], read: async () => ({}) };
  const setup = await createSetup(directory, moderation, provisioner, store);
  return {
    directory,
    setup,
    records,
    store,
    reload: () => createSetup(directory, moderation, provisioner, store),
    uncertain: () => {
      uncertain = true;
    },
    deployments: () => deployments,
    stop: () => rm(directory, { recursive: true, force: true }),
  };
}
test("managed setup persists references only, invalidates changed scopes and recovers uncertain saves", async () => {
  const f = await setupFixture();
  try {
    await f.setup.configureLearning(settings());
    await assert.rejects(
      f.setup.saveLearningSecrets({
        ELEVENLABS_API_KEY: "fixture-speech-value",
      }),
      /Connect/,
    );
    await f.setup.connectLearningSecrets();
    await f.setup.saveLearningSecrets({
      ELEVENLABS_API_KEY: "fixture-speech-value",
    });
    await f.setup.reviewLearning();
    assert.equal(f.setup.snapshot().learning.acceptance.credentials, true);
    assert.equal(f.setup.snapshot().learning.acceptance.deployment, false);
    const persisted = await readFile(
      join(f.directory, "learning-setup.json"),
      "utf8",
    );
    assert.equal(persisted.includes("fixture-speech-value"), false);
    assert.equal(
      JSON.stringify(f.setup.snapshot()).includes("fixture-speech-value"),
      false,
    );
    const reload = await f.reload();
    assert.equal(reload.snapshot().learning.connected, false);
    assert.deepEqual(reload.snapshot().learning.saved, []);
    await reload.connectLearningSecrets();
    assert.equal(reload.snapshot().learning.acceptance.credentials, true);
    await reload.configureLearning(settings("b"));
    assert.equal(reload.snapshot().learning.connected, false);
    await reload.connectLearningSecrets();
    assert.deepEqual(reload.snapshot().learning.saved, []);
    await assert.rejects(reload.reviewLearning(), /Confirm required/);
    f.uncertain();
    await assert.rejects(
      reload.saveLearningSecrets({
        ELEVENLABS_API_KEY: "fixture-second-value",
      }),
      /Some values may be saved/,
    );
    assert.equal(reload.snapshot().learning.connected, false);
    await reload.connectLearningSecrets();
    await reload.reviewLearning();
    assert.equal(reload.snapshot().learning.acceptance.credentials, true);
    await assert.rejects(reload.deploy({}), /coordinator review/);
    assert.equal(f.deployments(), 0);
  } finally {
    await f.stop();
  }
});
test("setup HTTP writes enforce loopback host, Origin and CSRF before managed credential writes", async () => {
  const f = await setupFixture();
  const server = createWizardServer(f.setup, f.directory, {
    infisical: true,
    cloudflare: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    const state = (await (await fetch(origin + "/api/state")).json()) as {
      csrf: string;
    };
    const post = (
      path: string,
      value: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    assert.equal(
      (await post("/api/learning/settings", settings())).status,
      403,
    );
    assert.equal(
      (
        await post("/api/learning/settings", settings(), {
          Origin: "https://other.example",
          "X-Wizard-Token": state.csrf,
        })
      ).status,
      403,
    );
    const ok = await post("/api/learning/settings", settings(), {
      Origin: origin,
      "X-Wizard-Token": state.csrf,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(f.records.size, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.stop();
  }
});
test("connected learning is prospective and scoped to the current bot, account and generation", () => {
  const context = {
    communityId: bytes("a", 64),
    botId: "123",
    generation: 2,
    startedAtMs: 2000,
  };
  const link: ConnectedLearningLinkV1 = {
    version: 1,
    ...context,
    accountId: "account",
    wallet: bytes("1", 40),
    linkedAtMs: 2000,
    revokedAtMs: null,
  };
  assert.doesNotThrow(() => assertConnectedLearningLink(link, context));
  assert.throws(
    () => assertConnectedLearningLink(link, { ...context, startedAtMs: 1999 }),
    /not_prospective/,
  );
  for (const other of [
    { ...link, revokedAtMs: 3000 },
    { ...link, generation: 1 },
    { ...link, communityId: bytes("b", 64) },
    null,
  ])
    assert.throws(
      () => assertConnectedLearningLink(other, context),
      /link_required/,
    );
});

test("setup authority preflight refuses another community, missing grader authority or the wrong chain", async () => {
  const { verifyCommunityAuthority } = await import(
    "../packages/community-setup/authority.ts"
  );
  const s = settings();
  const policy = bytes("c", 64) as `0x${string}`;
  const answers: Record<string, unknown> = {
    communityId: s.communityId,
    communityOrigin: s.origin,
    controller: s.owner,
    publicityPolicy: policy,
    graders: true,
  };
  const reader = {
    chainId: async () => 6343,
    code: async () => "0x6001",
    read: async (_: string, method: string) => answers[method],
  };
  assert.equal(
    (await verifyCommunityAuthority(s, policy, reader)).communityId,
    s.communityId,
  );
  await assert.rejects(
    verifyCommunityAuthority(s, policy, { ...reader, chainId: async () => 1 }),
    /chain_mismatch/,
  );
  answers.graders = false;
  await assert.rejects(
    verifyCommunityAuthority(s, policy, reader),
    /grader_permission/,
  );
  answers.graders = true;
  answers.communityId = bytes("b", 64);
  await assert.rejects(
    verifyCommunityAuthority(s, policy, reader),
    /context_mismatch/,
  );
});

test("fresh-community bindings never invent legacy contracts or reuse a shared speech Worker", async () => {
  const { communityLearningBindings, COMMUNITY_LEARNING_PROFILE_V1 } =
    await import("../packages/community-setup/bindings.ts");
  const a = communityLearningBindings(settings(), source),
    b = communityLearningBindings(settings("b"), source);
  assert.equal(a.operator.OPERATOR_PROFILE, COMMUNITY_LEARNING_PROFILE_V1);
  assert.equal(a.operator.RESULTS_V4_CONTRACT, settings().resultsContract);
  assert.equal("RESULTS_V2_CONTRACT" in a.operator, false);
  assert.equal("RESULTS_V3_CONTRACT" in a.operator, false);
  assert.equal(
    a.operatorServiceBinding.service,
    a.plan.resources.learningWorker,
  );
  assert.notEqual(
    a.operatorServiceBinding.service,
    b.operatorServiceBinding.service,
  );
  assert.equal(
    a.application.STUDY_RESULTS_V4_CONTRACT,
    a.operator.RESULTS_V4_CONTRACT,
  );
  assert.equal(a.accountId, a.plan.resources.ownerAccountId);
});
