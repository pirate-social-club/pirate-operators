import { createHash } from "node:crypto";

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const secretNames = [
  "OPENAI_API_KEY",
  "ACRCLOUD_ACCESS_KEY",
  "ACRCLOUD_ACCESS_SECRET",
  "CLOUDCONVERT_API_KEY",
] as const;
export type SecretName = (typeof secretNames)[number];
export interface Settings {
  name: string;
  slug: string;
  accountId: string;
  subdomain: string;
  projectId: string;
  environment: string;
  secretPath: string;
  acrHost: string;
  cloudconvert: boolean;
  tld: string;
}
export interface Plan {
  id: string;
  revision: number;
  origin: string;
  accountId: string;
  resources: { kind: string; name: string; purpose: string }[];
  sourceDigest: string;
}
export interface SetupState {
  version: 1;
  revision: number;
  settings?: Settings;
  secrets: SecretName[];
  plan?: Plan;
  deployment:
    | "not_started"
    | "running"
    | "interrupted"
    | "failed"
    | "update_pending"
    | "provisioned";
  attempted: boolean;
  message?: string;
}
export const initialState = (): SetupState => ({
  version: 1,
  revision: 0,
  secrets: [],
  deployment: "not_started",
  attempted: false,
});
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SetupError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function field(
  input: Record<string, unknown>,
  key: string,
  regex: RegExp,
  message: string,
) {
  const value = input[key];
  if (typeof value !== "string" || !regex.test(value))
    throw new SetupError(message);
  return value;
}
export function settingsFrom(value: unknown): Settings {
  const input = object(value);
  const fields = [
    "name",
    "slug",
    "accountId",
    "subdomain",
    "projectId",
    "environment",
    "secretPath",
    "acrHost",
    "cloudconvert",
    "tld",
  ];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new SetupError(
      "Unknown setting. Credentials belong in the secrets step.",
    );
  if (typeof input.cloudconvert !== "boolean")
    throw new SetupError("Choose whether CloudConvert is needed.");
  return {
    name: field(
      input,
      "name",
      /^[^<>\x00-\x1f]{1,80}$/u,
      "Enter a community name, up to 80 characters.",
    ),
    slug: field(
      input,
      "slug",
      /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/,
      "Use 3–30 lowercase letters, numbers or hyphens for the deployment ID.",
    ),
    accountId: field(
      input,
      "accountId",
      /^[a-f0-9]{32}$/,
      "Enter your 32-character Cloudflare account ID.",
    ),
    subdomain: field(
      input,
      "subdomain",
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
      "Enter your existing workers.dev account subdomain.",
    ),
    projectId: field(
      input,
      "projectId",
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
      "Enter the Infisical project UUID.",
    ),
    environment: field(
      input,
      "environment",
      /^[a-z][a-z0-9-]{0,30}$/,
      "Enter the Infisical environment slug.",
    ),
    secretPath: field(
      input,
      "secretPath",
      /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/,
      "Use a dedicated existing Infisical folder, such as /communities/c22.",
    ),
    acrHost: field(
      input,
      "acrHost",
      /^identify-[a-z0-9-]+\.acrcloud\.com$/,
      "Enter your ACRCloud identify host, without https://.",
    ),
    cloudconvert: input.cloudconvert,
    tld: field(
      input,
      "tld",
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$/,
      "Enter an optional HNS TLD label, without a dot.",
    ),
  };
}
export function requiredSecrets(s: Settings): SecretName[] {
  return [
    ...secretNames.filter((name) => name !== "CLOUDCONVERT_API_KEY"),
    ...(s.cloudconvert ? ["CLOUDCONVERT_API_KEY" as const] : []),
  ];
}
export function secretsFrom(
  value: unknown,
): Partial<Record<SecretName, string>> {
  const input = object(value);
  if (!Object.keys(input).length)
    throw new SetupError("Enter at least one credential.");
  for (const [key, secret] of Object.entries(input)) {
    if (
      !secretNames.includes(key as SecretName) ||
      typeof secret !== "string" ||
      secret.length < 1 ||
      secret.length > 4096 ||
      /[\x00-\x1f]/.test(secret)
    ) {
      throw new SetupError("Invalid provider credential field or value.");
    }
  }
  return input as Partial<Record<SecretName, string>>;
}
export function makePlan(
  s: Settings,
  revision: number,
  sourceDigest: string,
): Plan {
  const prefix = `pirate-${s.slug}`;
  const data = {
    revision,
    sourceDigest,
    accountId: s.accountId,
    origin: `https://${prefix}.${s.subdomain}.workers.dev`,
    resources: [
      {
        kind: "Worker",
        name: prefix,
        purpose: "Community setup page; posting integration pending",
      },
      {
        kind: "D1",
        name: `${prefix}-db`,
        purpose: "Community database and schema",
      },
      { kind: "R2", name: `${prefix}-media`, purpose: "Private media storage" },
      {
        kind: "Queue",
        name: `${prefix}-jobs`,
        purpose: "Job transport; moderation consumer pending",
      },
    ],
  };
  return {
    ...data,
    id: createHash("sha256")
      .update(JSON.stringify({ settings: s, ...data }))
      .digest("hex"),
  };
}
export function readiness(state: SetupState) {
  return [
    {
      title: "Provider credentials",
      state:
        state.settings &&
        requiredSecrets(state.settings).every((k) => state.secrets.includes(k))
          ? "saved"
          : "needed",
      detail: "Stored in Infisical. Real provider checks are still required.",
    },
    {
      title: "Cloudflare infrastructure",
      state: state.deployment,
      detail:
        "Alchemy provisions the setup page, database, private storage and job queue.",
    },
    {
      title: "Moderation and publication",
      state: "integration_pending",
      detail:
        "Connect real ACRCloud/OpenAI checks, the release gate, sealed media and public IPFS publication.",
    },
    {
      title: "Creator activation",
      state: "integration_pending",
      detail:
        "Connect the creator-wallet pilot and confirmed registration before upload.",
    },
    {
      title: "Community directory and song posts",
      state: "contracts_pending",
      detail:
        "Configure shared directory and post contracts, then register this community and its publisher.",
    },
    {
      title: "First song",
      state: "not_ready",
      detail:
        "Requires an admitted, registered, published song that plays after reload.",
    },
  ];
}
