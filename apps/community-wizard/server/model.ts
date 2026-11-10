import { createHash } from "node:crypto";

export class SetupError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
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
  moderationMode: "pirate" | "independent";
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
  secretStoreSite?: string;
  revision: number;
  settings?: Settings;
  secrets: SecretName[];
  plan?: Plan;
  deployment:
    | "not_started"
    | "running"
    | "health_pending"
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
  const input = { ...object(value) };
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
    "moderationMode",
  ];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new SetupError(
      "Unknown setting. Credentials belong in the secrets step.",
    );
  if (typeof input.cloudconvert !== "boolean")
    throw new SetupError("Choose whether CloudConvert is needed.");
  if (
    input.moderationMode !== "pirate" &&
    input.moderationMode !== "independent"
  )
    throw new SetupError("Choose a moderation service.");
  if (input.moderationMode === "pirate") {
    input.projectId = "";
    input.environment = "";
    input.secretPath = "";
    input.acrHost = "";
    input.cloudconvert = false;
  }
  const independent = input.moderationMode === "independent";
  return {
    moderationMode: input.moderationMode,
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
    projectId: !independent
      ? ""
      : field(
          input,
          "projectId",
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
          "Enter the Infisical project UUID.",
        ),
    environment: !independent
      ? ""
      : field(
          input,
          "environment",
          /^[a-z][a-z0-9-]{0,30}$/,
          "Enter the Infisical environment slug.",
        ),
    secretPath: !independent
      ? ""
      : field(
          input,
          "secretPath",
          /^\/(?=.{1,240}$)(?:[a-zA-Z0-9_-]+\/){0,7}[a-zA-Z0-9_-]+$/,
          "Choose a dedicated Infisical folder with up to eight path segments, such as /communities/c22.",
        ),
    acrHost: !independent
      ? ""
      : field(
          input,
          "acrHost",
          /^identify-[a-z0-9-]+\.acrcloud\.com$/,
          "Enter your ACRCloud identify host, without https://.",
        ),
    cloudconvert: independent && input.cloudconvert === true,
    tld: field(
      input,
      "tld",
      /^(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
      "Choose the community TLD now: 1–63 lowercase registry-label characters, without a dot. Delegation is not required for provisioning.",
    ),
  };
}
export function requiredSecrets(s: Settings): SecretName[] {
  if (s.moderationMode === "pirate") return [];
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
  s = settingsFrom(s); // Also refuse invalid/blank namespace in older persisted state.
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
      title:
        state.settings?.moderationMode === "pirate"
          ? "Moderation service"
          : "Provider credentials",
      state:
        state.settings?.moderationMode === "pirate"
          ? "managed"
          : state.settings &&
              requiredSecrets(state.settings).every((k) =>
                state.secrets.includes(k),
              )
            ? "saved"
            : "needed",
      detail:
        state.settings?.moderationMode === "pirate"
          ? "Pirate-operated moderation selected. Service pairing and signed results still need verification; no provider keys belong in this community."
          : "Independent operator credentials saved to its Infisical scope. Service identity and provider checks still need verification.",
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
        "Operator-sponsored test setup with a capped budget; no creator checkout. Connect the wallet and confirmed registration before upload.",
    },
    {
      title: "Community directory and song posts",
      state: "contracts_pending",
      detail:
        "Use a genuine test registry and unverified directory entry to exercise publishing over HTTPS. HNS verification is not a song-test gate.",
    },
    {
      title: "Verified Pirate discovery · optional for tests",
      state: "unverified",
      detail:
        "HNS delegation and a fresh namespace attestation gate verified listing. Opening app.tld is a separate browser/transport check.",
    },
    {
      title: "First song",
      state: "not_ready",
      detail:
        "Requires an admitted, registered, published song that plays after reload.",
    },
  ];
}
