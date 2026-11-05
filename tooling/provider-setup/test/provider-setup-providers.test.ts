import {
  categories,
  MODERATION_MODEL,
  CLASSIFICATION_MODEL,
} from "../../../packages/moderation/openai.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "../http.ts";
import { digest } from "../model.ts";
import { provisionAcr, qualifyAcr } from "../acrcloud.ts";
import { provisionOpenAi, qualifyOpenAi } from "../openai.ts";
import { memoryVault, state } from "./provider-setup-fixtures.ts";

const json = (value: unknown) => Response.json(value);
test("ACR setup recovers a lost create, retains exact catalog and verifies both signed controls", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("ACRCLOUD_CONSOLE_TOKEN", "console-only-secret");
  const positive = new Uint8Array([1, 2, 3]),
    negative = new Uint8Array([3, 2, 1]);
  const positivePath = join(store.directory, "positive.mp3"),
    negativePath = join(store.directory, "negative.mp3");
  await writeFile(positivePath, positive, { mode: 0o600 });
  await writeFile(negativePath, negative, { mode: 0o600 });
  store.journal!.plan.profile.samples = {
    positive: { path: positivePath, sha256: digest(positive) },
    negative: { path: negativePath, sha256: digest(negative) },
  };
  await store.save();
  let project: Record<string, unknown> | undefined,
    creates = 0,
    recognizes = 0;
  const send = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/buckets")
      return json({
        data: [{ id: 23, name: "ACRCloud Music", type: "ACRCloudFile" }],
        meta: { last_page: 1 },
      });
    if (url.pathname === "/api/base-projects" && request.method === "POST") {
      creates++;
      const body = await request.json();
      assert.deepEqual(body.buckets, [23]);
      assert.equal(body.type, "AVR");
      project = {
        id: 42,
        name: body.name,
        service_type: "AVR",
        state: 1,
        region: body.region,
        audio_type: "linein",
        buckets: [{ id: 23, type: "ACRCloudFile" }],
        access_key: "project-access-key",
        access_secret: "project-access-secret",
        day_limit: 0,
        total_limit: 0,
      };
      throw Error("lost create response");
    }
    if (url.pathname === "/api/base-projects")
      return json({ data: project ? [project] : [], meta: { last_page: 1 } });
    assert.equal(url.hostname, "identify-eu-west-1.acrcloud.com");
    assert.equal(request.headers.get("authorization"), null);
    const form = await request.formData(),
      timestamp = String(form.get("timestamp"));
    const expected = createHmac("sha1", "project-access-secret")
      .update(
        [
          "POST",
          "/v1/identify",
          "project-access-key",
          "audio",
          "1",
          timestamp,
        ].join("\n"),
      )
      .digest("base64");
    assert.equal(form.get("signature"), expected);
    recognizes++;
    const sample = new Uint8Array(
      await (form.get("sample") as File).arrayBuffer(),
    );
    return digest(sample) === digest(positive)
      ? json({
          status: { code: 0 },
          metadata: { music: [{ acrid: "known-match" }] },
        })
      : json({ status: { code: 1001 } });
  };
  const ctx = new Context(store, vault, send);
  await assert.rejects(provisionAcr(ctx), /uncertain/);
  await provisionAcr(ctx);
  await qualifyAcr(ctx);
  await provisionAcr(ctx);
  await qualifyAcr(ctx);
  assert.equal(creates, 1);
  assert.equal(recognizes, 2);
  assert.equal(
    vault.runtime.get("ACRCLOUD_ACCESS_SECRET"),
    "project-access-secret",
  );
  const disk = await readFile(join(store.directory, "journal.json"), "utf8");
  assert(
    !disk.includes("project-access-secret") &&
      !disk.includes("console-only-secret"),
  );
  assert.equal(
    store.journal!.steps["acr.project"].receipt!.remainingQuota,
    "not_reported",
  );
});
test("missing music catalog cannot create an empty-database recognition project", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("ACRCLOUD_CONSOLE_TOKEN", "console-token");
  let creates = 0;
  const ctx = new Context(store, vault, async (r) => {
    if (r.method === "POST") creates++;
    return json({ data: [], meta: { last_page: 1 } });
  });
  await assert.rejects(provisionAcr(ctx), /catalog_needs_confirmation/);
  assert.equal(creates, 0);
});
function openAiFake(planName: string, accountName: string) {
  const tally = { projects: 0, accounts: 0, moderation: 0, classification: 0 };
  let project: Record<string, unknown> | undefined,
    account: Record<string, unknown> | undefined;
  const send = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/organization")) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer administrative-only-secret",
      );
      assert.equal(request.headers.get("openai-organization"), "org-test");
      if (path === "/v1/organization/projects" && request.method === "POST") {
        tally.projects++;
        project = { id: "proj_test", name: planName, status: "active" };
        return json(project);
      }
      if (path === "/v1/organization/projects")
        return json({ data: project ? [project] : [], has_more: false });
      if (path.endsWith("/service_accounts") && request.method === "POST") {
        tally.accounts++;
        account = {
          id: "svc_acct_test",
          name: accountName,
          role: "member",
          api_key: { id: "key_test", value: "sk-runtime-only-secret" },
        };
        return json(account);
      }
      if (path.endsWith("/service_accounts"))
        return json({ data: account ? [account] : [], has_more: false });
      return json(account);
    }
    assert.equal(
      request.headers.get("authorization"),
      "Bearer sk-runtime-only-secret",
    );
    const body = await request.json();
    if (path === "/v1/moderations") {
      tally.moderation++;
      return json({
        id: "mod-fixture",
        model: MODERATION_MODEL,
        results: [0, 1].map(() => ({
          flagged: false,
          categories: Object.fromEntries(categories.map((c) => [c, false])),
          category_scores: Object.fromEntries(categories.map((c) => [c, 0.01])),
          category_applied_input_types: Object.fromEntries(
            categories.map((c) => [c, ["text"]]),
          ),
        })),
      });
    }
    assert.equal(path, "/v1/responses");
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.store, false);
    tally.classification++;
    return json({
      id: "resp-fixture",
      model: CLASSIFICATION_MODEL,
      usage: { input_tokens: 20, output_tokens: 20 },
      status: "completed",
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: '{"primaryLanguage":"en","explicit":false,"titleRating":"general","lyricsRating":"general"}',
            },
          ],
        },
      ],
    });
  };
  return { send, tally };
}
test("OpenAI saves a project credential and uses it, not the admin key, for bounded qualification", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("OPENAI_ADMIN_KEY", "administrative-only-secret");
  const fake = openAiFake(
    store.journal!.plan.names.openai,
    store.journal!.plan.names.serviceAccount,
  );
  const ctx = new Context(store, vault, fake.send);
  await provisionOpenAi(ctx);
  await qualifyOpenAi(ctx);
  await provisionOpenAi(ctx);
  await qualifyOpenAi(ctx);
  assert.deepEqual(fake.tally, {
    projects: 1,
    accounts: 1,
    moderation: 1,
    classification: 1,
  });
  const disk = await readFile(join(store.directory, "journal.json"), "utf8");
  assert(
    !disk.includes("sk-runtime-only-secret") &&
      !disk.includes("administrative-only-secret"),
  );
});
test("a lost OpenAI one-time key response cannot create a replacement account or key", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("OPENAI_ADMIN_KEY", "administrative-only-secret");
  const fake = openAiFake(
    store.journal!.plan.names.openai,
    store.journal!.plan.names.serviceAccount,
  );
  const ctx = new Context(store, vault, async (request) => {
    const result = await fake.send(request);
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("service_accounts")
    )
      throw Error("secret response lost");
    return result;
  });
  await assert.rejects(provisionOpenAi(ctx), /uncertain/);
  await assert.rejects(provisionOpenAi(ctx), /key_response_lost/);
  assert.equal(fake.tally.accounts, 1);
  assert.equal(vault.runtime.size, 0);
});
test("a vault interruption after OpenAI creation recovers only the exact saved one-time key", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("OPENAI_ADMIN_KEY", "administrative-only-secret");
  const fake = openAiFake(
    store.journal!.plan.names.openai,
    store.journal!.plan.names.serviceAccount,
  );
  const saved = vault.put;
  vault.put = async (key, value) => {
    await saved(key, value);
    throw Error("vault reply lost");
  };
  const ctx = new Context(store, vault, fake.send);
  await assert.rejects(provisionOpenAi(ctx));
  vault.put = saved;
  await provisionOpenAi(ctx);
  assert.equal(fake.tally.accounts, 1);
  assert.equal(store.journal!.steps["openai.account"].state, "done");
});
test("invalid OpenAI setup authentication fails before a create intent and can be corrected", async () => {
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("OPENAI_ADMIN_KEY", "administrative-only-secret");
  const fake = openAiFake(
    store.journal!.plan.names.openai,
    store.journal!.plan.names.serviceAccount,
  );
  let invalid = true;
  const ctx = new Context(store, vault, (request) =>
    invalid
      ? Promise.resolve(new Response("private-error", { status: 401 }))
      : fake.send(request),
  );
  await assert.rejects(provisionOpenAi(ctx), /provider_http_401/);
  assert.equal(store.journal!.steps["openai.project"], undefined);
  invalid = false;
  await provisionOpenAi(ctx);
  assert.equal(fake.tally.projects, 1);
  assert.equal(fake.tally.accounts, 1);
});
