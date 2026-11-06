import { createHmac } from "node:crypto";
import {
  object,
  text,
  integer,
  requireThat,
  digest,
  type Receipt,
} from "./model.ts";
import { readPrivate } from "./journal.ts";
import { Context } from "./http.ts";

const origin = "https://api-v2.acrcloud.com/api";
async function catalog(ctx: Context, token: string) {
  if (ctx.plan.profile.musicBucketId) return ctx.plan.profile.musicBucketId;
  const found: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = object(
      await ctx.json(`${origin}/buckets?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    requireThat(Array.isArray(result.data), "acr_catalog_response_invalid");
    for (const value of result.data) {
      const bucket = object(value);
      if (bucket.name === "ACRCloud Music" && bucket.type === "ACRCloudFile")
        found.push(integer(bucket.id));
    }
    const last = integer(object(result.meta).last_page);
    requireThat(last <= 10, "acr_catalog_pagination_bound");
    if (page >= last) break;
  }
  requireThat(
    found.length === 1 && found[0] > 0,
    "acr_music_catalog_needs_confirmation",
  );
  return found[0];
}
async function projectByName(ctx: Context, token: string) {
  const found: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = object(
      await ctx.json(
        `${origin}/base-projects?type=AVR&region=${ctx.plan.profile.acrRegion}&per_page=100&page=${page}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    requireThat(Array.isArray(result.data), "acr_projects_invalid");
    for (const value of result.data)
      if (object(value).name === ctx.plan.names.acrcloud)
        found.push(object(value));
    const last = integer(object(result.meta).last_page);
    requireThat(last <= 10, "acr_project_pagination_bound");
    if (page >= last) break;
  }
  requireThat(found.length <= 1, "acr_project_ambiguous");
  return found[0];
}
async function retain(
  ctx: Context,
  data: Record<string, unknown>,
  bucketId: number,
): Promise<Receipt> {
  requireThat(
    data.name === ctx.plan.names.acrcloud &&
      data.region === ctx.plan.profile.acrRegion &&
      data.service_type === "AVR" &&
      data.audio_type === "linein" &&
      data.state === 1,
    "acr_project_binding_mismatch",
  );
  requireThat(
    Array.isArray(data.buckets) &&
      data.buckets.length === 1 &&
      object(data.buckets[0]).id === bucketId &&
      object(data.buckets[0]).type === "ACRCloudFile",
    "acr_music_catalog_mismatch",
  );
  const id = integer(data.id);
  requireThat(id > 0, "acr_project_id_invalid");
  const key = text(data.access_key, /^[A-Za-z0-9_-]{8,512}$/),
    secret = text(data.access_secret, /^[\x21-\x7e]{8,512}$/);
  await ctx.vault.put("ACRCLOUD_ACCESS_KEY", key);
  await ctx.vault.put("ACRCLOUD_ACCESS_SECRET", secret);
  return {
    projectId: id,
    catalogId: bucketId,
    region: ctx.plan.profile.acrRegion,
    dayLimit: data.day_limit === undefined ? null : integer(data.day_limit),
    totalLimit:
      data.total_limit === undefined ? null : integer(data.total_limit),
    remainingQuota: "not_reported",
    host: `identify-${ctx.plan.profile.acrRegion}.acrcloud.com`,
  };
}
export async function provisionAcr(ctx: Context) {
  const token = await ctx.secret("bootstrap", "ACRCLOUD_CONSOLE_TOKEN");
  const selected = await ctx.store.once(
    "acr.catalog",
    async () => ({ catalogId: await catalog(ctx, token) }),
    async () => ({ catalogId: await catalog(ctx, token) }),
  );
  const bucketId = integer(selected.catalogId);
  if (!ctx.store.journal?.steps["acr.project"])
    requireThat(
      !(await projectByName(ctx, token)),
      "acr_project_already_exists",
    );
  return ctx.store.once(
    "acr.project",
    async () => {
      const result = object(
        await ctx.json(`${origin}/base-projects`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: ctx.plan.names.acrcloud,
            region: ctx.plan.profile.acrRegion,
            type: "AVR",
            audio_type: "linein",
            buckets: [bucketId],
          }),
        }),
      );
      return retain(ctx, object(result.data), bucketId);
    },
    async () => {
      const data = await projectByName(ctx, token);
      requireThat(data, "acr_create_uncertain_no_replacement");
      return retain(ctx, data, bucketId);
    },
  );
}
export async function qualifyAcr(ctx: Context) {
  requireThat(
    ctx.store.journal?.steps["acr.project"]?.state === "done",
    "acr_setup_required",
  );
  const samples = ctx.plan.profile.samples;
  requireThat(samples, "acr_controls_required_in_plan");
  const key = await ctx.secret("runtime", "ACRCLOUD_ACCESS_KEY"),
    secret = await ctx.secret("runtime", "ACRCLOUD_ACCESS_SECRET");
  for (const kind of ["positive", "negative"] as const) {
    if (ctx.store.journal?.steps[`acr.${kind}`]?.state === "done") continue;
    const sample = await readPrivate(samples[kind].path, 4_000_000);
    requireThat(
      sample.length > 0 && digest(sample) === samples[kind].sha256,
      "acr_sample_binding_mismatch",
    );
    await ctx.store.once(`acr.${kind}`, async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha1", secret)
        .update(
          ["POST", "/v1/identify", key, "audio", "1", timestamp].join("\n"),
        )
        .digest("base64");
      const form = new FormData();
      for (const [name, value] of Object.entries({
        access_key: key,
        sample_bytes: String(sample.length),
        timestamp,
        signature,
        data_type: "audio",
        signature_version: "1",
      }))
        form.append(name, value);
      form.append(
        "sample",
        new Blob([new Uint8Array(sample)], { type: "audio/mpeg" }),
        "control.mp3",
      );
      const response = object(
        await ctx.json(
          `https://identify-${ctx.plan.profile.acrRegion}.acrcloud.com/v1/identify`,
          { method: "POST", body: form },
        ),
      );
      const code = integer(object(response.status).code);
      if (kind === "positive") {
        const music = object(response.metadata).music;
        requireThat(
          code === 0 && Array.isArray(music) && music.length > 0,
          "acr_known_music_not_matched",
        );
      } else requireThat(code === 1001, "acr_negative_control_not_unmatched");
      return { providerCode: code, sampleSha256: digest(sample), passed: true };
    });
  }
}
