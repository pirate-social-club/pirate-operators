import {
  moderateText,
  classifyLyrics,
} from "../../packages/moderation/openai.ts";
import { defaultContentProfile } from "../../packages/moderation/content-profile.ts";
import {
  digest,
  object,
  text,
  requireThat,
  SetupFailure,
  type Receipt,
} from "./model.ts";
import { Context } from "./http.ts";

const base = "https://api.openai.com/v1";
function headers(ctx: Context, token: string) {
  requireThat(
    ctx.plan.profile.openaiOrganization,
    "openai_organization_required",
  );
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "OpenAI-Organization": ctx.plan.profile.openaiOrganization,
  };
}
async function find(ctx: Context, url: string, token: string, name: string) {
  let after = "";
  const matches: Record<string, unknown>[] = [];
  for (let page = 0; page < 10; page++) {
    const result = object(
      await ctx.json(
        `${url}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        { headers: headers(ctx, token) },
      ),
    );
    requireThat(Array.isArray(result.data), "openai_list_invalid");
    for (const row of result.data)
      if (object(row).name === name) matches.push(object(row));
    requireThat(matches.length <= 1, "openai_resource_ambiguous");
    if (result.has_more === false) return matches[0];
    requireThat(result.has_more === true, "openai_pagination_invalid");
    after = text(result.last_id, /^[A-Za-z0-9_-]{1,160}$/);
  }
  throw new SetupFailure("openai_pagination_bound");
}
export async function provisionOpenAi(ctx: Context) {
  requireThat(
    ctx.plan.profile.openaiOrganization,
    "openai_organization_required",
  );
  const admin = await ctx.secret("bootstrap", "OPENAI_ADMIN_KEY");
  const projectReceipt = (data: Record<string, unknown>): Receipt => {
    requireThat(
      data.name === ctx.plan.names.openai && data.status === "active",
      "openai_project_binding_mismatch",
    );
    return { projectId: text(data.id, /^proj_[A-Za-z0-9_-]{1,100}$/) };
  };
  if (!ctx.store.journal?.steps["openai.project"])
    requireThat(
      !(await find(
        ctx,
        `${base}/organization/projects`,
        admin,
        ctx.plan.names.openai,
      )),
      "openai_project_already_exists",
    );
  const project = await ctx.store.once(
    "openai.project",
    async () => {
      return projectReceipt(
        object(
          await ctx.json(`${base}/organization/projects`, {
            method: "POST",
            headers: headers(ctx, admin),
            body: JSON.stringify({ name: ctx.plan.names.openai }),
          }),
        ),
      );
    },
    async () => {
      const data = await find(
        ctx,
        `${base}/organization/projects`,
        admin,
        ctx.plan.names.openai,
      );
      requireThat(data, "openai_project_uncertain_no_replacement");
      return projectReceipt(data);
    },
  );
  const projectId = text(project.projectId, /^proj_[A-Za-z0-9_-]{1,100}$/);
  const url = `${base}/organization/projects/${projectId}/service_accounts`;
  if (!ctx.store.journal?.steps["openai.account"])
    requireThat(
      !(await find(ctx, url, admin, ctx.plan.names.serviceAccount)),
      "openai_service_account_already_exists",
    );
  return ctx.store.once(
    "openai.account",
    async () => {
      const data = object(
        await ctx.json(url, {
          method: "POST",
          headers: headers(ctx, admin),
          body: JSON.stringify({ name: ctx.plan.names.serviceAccount }),
        }),
      );
      requireThat(
        data.name === ctx.plan.names.serviceAccount && data.role === "member",
        "openai_account_binding_mismatch",
      );
      const key = object(data.api_key),
        value = text(key.value, /^sk-[A-Za-z0-9_-]{8,1000}$/);
      const receipt = {
        projectId,
        accountId: text(data.id, /^svc_acct_[A-Za-z0-9_-]{1,100}$/),
        keyId: text(key.id, /^[A-Za-z0-9_-]{1,160}$/),
        keySha256: digest(value),
      };
      // Save only identity and a digest before vault persistence. Never save the one-time key locally.
      await ctx.store.note("openai.account", receipt);
      await ctx.vault.put("OPENAI_API_KEY", value);
      return receipt;
    },
    async (receipt) => {
      requireThat(
        receipt && receipt.projectId === projectId,
        "openai_key_response_lost_owner_recovery_required",
      );
      const id = text(receipt.accountId, /^svc_acct_[A-Za-z0-9_-]{1,100}$/);
      const account = object(
        await ctx.json(
          `${base}/organization/projects/${projectId}/service_accounts/${id}`,
          { headers: headers(ctx, admin) },
        ),
      );
      requireThat(
        account.id === id && account.name === ctx.plan.names.serviceAccount,
        "openai_account_binding_mismatch",
      );
      const value = await ctx.vault.get("runtime", "OPENAI_API_KEY");
      requireThat(
        value && digest(value) === receipt.keySha256,
        "openai_key_not_recoverable_no_replacement",
      );
      return receipt;
    },
  );
}
export async function qualifyOpenAi(ctx: Context) {
  requireThat(
    ctx.store.journal?.steps["openai.account"]?.state === "done",
    "openai_setup_required",
  );
  const key = await ctx.secret("runtime", "OPENAI_API_KEY");
  const transport = {
    request: async (request: Request) =>
      ctx.request(request.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      }),
  };
  const title = "Morning",
    lyrics = "A quiet morning and a friendly hello.";
  await ctx.store.once("openai.moderation", async () => {
    const data = await moderateText(
      title,
      lyrics,
      key,
      async () => {},
      transport,
    );
    requireThat(
      data.results.every((r) => !r.adult),
      "openai_moderation_control_failed",
    );
    return {
      passed: true,
      model: defaultContentProfile.moderationModel,
      requests: 1,
    };
  });
  await ctx.store.once("openai.classification", async () => {
    const data = await classifyLyrics(
      title,
      lyrics,
      key,
      async () => {},
      transport,
    );
    requireThat(
      data.classification.primaryLanguage === "en" &&
        data.classification.explicit === false &&
        data.classification.titleRating === "general" &&
        data.classification.lyricsRating === "general",
      "openai_classification_control_failed",
    );
    return {
      passed: true,
      model: defaultContentProfile.classificationModel,
      promptVersion: defaultContentProfile.promptVersion,
      schemaVersion: defaultContentProfile.schemaVersion,
      requests: 1,
      maxOutputTokens: 256,
    };
  });
}
