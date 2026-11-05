import { createHash, randomUUID } from "node:crypto";

export class SetupFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new SetupFailure(code);
}
export function object(value: unknown): Record<string, unknown> {
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_object",
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown, pattern: RegExp): string {
  requireThat(
    typeof value === "string" && pattern.test(value),
    "invalid_identifier",
  );
  return value;
}
export function integer(value: unknown): number {
  requireThat(
    Number.isSafeInteger(value) && Number(value) >= 0,
    "invalid_integer",
  );
  return Number(value);
}
export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const regions = ["eu-west-1", "us-west-2", "ap-southeast-1"] as const;
export interface Sample {
  path: string;
  sha256: string;
}
export interface Profile {
  slug: string;
  vault: {
    projectId: string;
    environment: string;
    bootstrapPath: string;
    runtimePath: string;
  };
  acrRegion: (typeof regions)[number];
  musicBucketId?: number;
  openaiOrganization: string;
  samples?: { positive: Sample; negative: Sample };
}
export interface Plan {
  schema: "pirate.provider-setup/1";
  intent: string;
  profile: Profile;
  names: {
    acrcloud: string;
    openai: string;
    serviceAccount: string;
    filebase: string;
  };
  limits: {
    acrIdentify: 2;
    openaiModeration: 1;
    openaiClassification: 1;
    filebaseUpload: 1;
    independentRetrieval: 5;
  };
}
const pathPattern = /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/;
export function profileFrom(value: unknown): Profile {
  const p = object(value),
    v = object(p.vault);
  const vault = {
    projectId: text(v.projectId, /^[a-f0-9-]{36}$/i),
    environment: text(v.environment, /^[a-zA-Z0-9_-]{1,64}$/),
    bootstrapPath: text(v.bootstrapPath, pathPattern),
    runtimePath: text(v.runtimePath, pathPattern),
  };
  requireThat(
    !vault.bootstrapPath.startsWith(vault.runtimePath + "/") &&
      !vault.runtimePath.startsWith(vault.bootstrapPath + "/") &&
      vault.bootstrapPath !== vault.runtimePath,
    "separate_secret_scopes_required",
  );
  const acrRegion = text(
    p.acrRegion,
    /^(eu-west-1|us-west-2|ap-southeast-1)$/,
  ) as Profile["acrRegion"];
  const profile: Profile = {
    slug: text(p.slug, /^[a-z][a-z0-9-]{2,23}$/),
    vault,
    acrRegion,
    openaiOrganization: text(p.openaiOrganization, /^org-[A-Za-z0-9]{1,80}$/),
  };
  if (p.musicBucketId !== undefined) {
    profile.musicBucketId = integer(p.musicBucketId);
    requireThat(profile.musicBucketId > 0, "invalid_music_catalog");
  }
  if (p.samples !== undefined) {
    const samples = object(p.samples);
    const sample = (value: unknown): Sample => {
      const s = object(value);
      return {
        path: text(s.path, /^\/[^\x00-\x1f]{1,4095}$/),
        sha256: text(s.sha256, /^[a-f0-9]{64}$/),
      };
    };
    profile.samples = {
      positive: sample(samples.positive),
      negative: sample(samples.negative),
    };
    requireThat(
      profile.samples.positive.sha256 !== profile.samples.negative.sha256,
      "distinct_controls_required",
    );
  }
  requireThat(canonical(p) === canonical(profile), "unknown_profile_fields");
  return profile;
}
export function createPlan(
  input: unknown,
  intent: string = randomUUID(),
): Plan {
  text(intent, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  const profile = profileFrom(input),
    suffix = intent.replaceAll("-", "");
  return {
    schema: "pirate.provider-setup/1",
    intent,
    profile,
    names: {
      acrcloud: `pirate-${profile.slug}-${suffix}`,
      openai: `pirate-${profile.slug}-${suffix}`,
      serviceAccount: `community-${suffix}`,
      filebase: `pirate-${profile.slug}-${suffix.slice(0, 24)}`,
    },
    limits: {
      acrIdentify: 2,
      openaiModeration: 1,
      openaiClassification: 1,
      filebaseUpload: 1,
      independentRetrieval: 5,
    },
  };
}
export function planFrom(input: unknown): Plan {
  const p = object(input),
    expected = createPlan(p.profile, String(p.intent));
  requireThat(canonical(p) === canonical(expected), "invalid_plan");
  return expected;
}
export type Receipt = Record<string, string | number | boolean | null>;
export type Step = { state: "started" | "done"; receipt?: Receipt };
export interface Journal {
  plan: Plan;
  steps: Record<string, Step>;
}
export interface Vault {
  get(zone: "bootstrap" | "runtime", name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
}
