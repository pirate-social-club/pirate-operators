// Community setup/v1: secret references and review data, never credentials.
import { canonicalOriginV4 } from "../protocol/learning-results-v4.ts";
import { check, digest } from "../protocol/index.ts";
export interface CommunitySetupV1 {
  version: 1;
  communityId: string;
  slug: string;
  accountId: string;
  origin: string;
  operatorOrigin: string;
  chainId: 6343 | 31337;
  resultsContract: string;
  owner: string;
  grader: string;
  infisical: { projectId: string; environment: string; secretPath: string };
  limits: {
    sponsorWei: string;
    gasPriceWei: string;
    gasLimit: string;
    dataFeeWei: string;
    activationTotalWei: string;
    activationAccountWei: string;
    activationAccounts: number;
    speechDailyUnits: number;
    websiteReservedUnits: number;
    telegramDailyUnits: number;
    perAccountDailyUnits: number;
    providerMonthlyBudgetUsdCents: number;
  };
  telegram: { enabled: boolean; botId: string; generation: number };
  songs: { postId: string; revision: number; audioDigest: string }[];
}
function object(v: unknown): Record<string, unknown> {
  check(
    v !== null && typeof v === "object" && !Array.isArray(v),
    "setup_object_required",
  );
  return v as Record<string, unknown>;
}
function exact(v: unknown, keys: string[]) {
  const o = object(v);
  check(
    Object.keys(o).length === keys.length && keys.every((k) => k in o),
    "setup_unknown_or_missing_field",
  );
  return o;
}
function text(v: unknown, pattern: RegExp, code: string) {
  check(typeof v === "string" && pattern.test(v), code);
  return v;
}
function uint(v: unknown, zero = false) {
  check(
    typeof v === "number" && Number.isSafeInteger(v) && v >= (zero ? 0 : 1),
    "setup_invalid_limit",
  );
  return v;
}
function wei(v: unknown, zero = false) {
  const s = text(v, /^(0|[1-9][0-9]{0,77})$/, "setup_invalid_wei");
  check(zero || BigInt(s) > 0n, "setup_invalid_wei");
  return s;
}
const hash = (v: unknown) =>
  text(v, /^0x[0-9a-f]{64}$/, "setup_invalid_digest");
function address(v: unknown) {
  const s = text(v, /^0x[0-9a-f]{40}$/, "setup_invalid_address");
  check(!/^0x0+$/.test(s), "setup_invalid_address");
  return s;
}
function https(v: unknown) {
  const s = text(v, /^https:\/\//, "setup_https_required");
  const u = new URL(s);
  check(
    u.origin === s && !u.username && !u.password && canonicalOriginV4(s),
    "setup_https_origin_required",
  );
  return s;
}
export function communitySetupFrom(value: unknown): CommunitySetupV1 {
  const o = exact(value, [
    "version",
    "communityId",
    "slug",
    "accountId",
    "origin",
    "operatorOrigin",
    "chainId",
    "resultsContract",
    "owner",
    "grader",
    "infisical",
    "limits",
    "telegram",
    "songs",
  ]);
  check(
    o.version === 1 && (o.chainId === 6343 || o.chainId === 31337),
    "setup_testnet_only",
  );
  const inf = exact(o.infisical, ["projectId", "environment", "secretPath"]);
  const l = exact(o.limits, [
    "sponsorWei",
    "gasPriceWei",
    "gasLimit",
    "dataFeeWei",
    "activationTotalWei",
    "activationAccountWei",
    "activationAccounts",
    "speechDailyUnits",
    "websiteReservedUnits",
    "telegramDailyUnits",
    "perAccountDailyUnits",
    "providerMonthlyBudgetUsdCents",
  ]);
  const t = exact(o.telegram, ["enabled", "botId", "generation"]);
  check(typeof t.enabled === "boolean", "setup_invalid_telegram");
  const limits = {
    sponsorWei: wei(l.sponsorWei),
    gasPriceWei: wei(l.gasPriceWei),
    gasLimit: wei(l.gasLimit),
    dataFeeWei: wei(l.dataFeeWei, true),
    activationTotalWei: wei(l.activationTotalWei),
    activationAccountWei: wei(l.activationAccountWei),
    activationAccounts: uint(l.activationAccounts),
    speechDailyUnits: uint(l.speechDailyUnits),
    websiteReservedUnits: uint(l.websiteReservedUnits),
    telegramDailyUnits: uint(l.telegramDailyUnits, true),
    perAccountDailyUnits: uint(l.perAccountDailyUnits),
    providerMonthlyBudgetUsdCents: uint(l.providerMonthlyBudgetUsdCents),
  };
  const bundle =
    2n *
    (BigInt(limits.gasLimit) * BigInt(limits.gasPriceWei) +
      BigInt(limits.dataFeeWei));
  check(
    bundle <= BigInt(limits.activationAccountWei) &&
      BigInt(limits.activationAccountWei) <=
        BigInt(limits.activationTotalWei) &&
      BigInt(limits.activationTotalWei) <= BigInt(limits.sponsorWei),
    "setup_activation_caps_inconsistent",
  );
  check(
    limits.websiteReservedUnits <= limits.speechDailyUnits &&
      limits.telegramDailyUnits <=
        limits.speechDailyUnits - limits.websiteReservedUnits &&
      limits.perAccountDailyUnits <= limits.speechDailyUnits &&
      (t.enabled || limits.telegramDailyUnits === 0),
    "setup_speech_caps_inconsistent",
  );
  check(
    Array.isArray(o.songs) && o.songs.length <= 1000,
    "setup_invalid_songs",
  );
  const songs = o.songs.map((v) => {
    const s = exact(v, ["postId", "revision", "audioDigest"]);
    return {
      postId: hash(s.postId),
      revision: uint(s.revision),
      audioDigest: hash(s.audioDigest),
    };
  });
  check(
    new Set(songs.map((s) => s.postId)).size === songs.length,
    "setup_duplicate_song",
  );
  const result: CommunitySetupV1 = {
    version: 1,
    communityId: hash(o.communityId),
    slug: text(o.slug, /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/, "setup_invalid_slug"),
    accountId: text(o.accountId, /^[a-f0-9]{32}$/, "setup_invalid_account"),
    origin: https(o.origin),
    operatorOrigin: https(o.operatorOrigin),
    chainId: o.chainId,
    resultsContract: address(o.resultsContract),
    owner: address(o.owner),
    grader: address(o.grader),
    infisical: {
      projectId: text(
        inf.projectId,
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
        "setup_invalid_project",
      ),
      environment: text(
        inf.environment,
        /^[a-z][a-z0-9-]{0,30}$/,
        "setup_invalid_environment",
      ),
      secretPath: text(
        inf.secretPath,
        /^\/(?:[a-zA-Z0-9_-]+\/){0,7}[a-zA-Z0-9_-]{1,80}$/,
        "setup_invalid_secret_path",
      ),
    },
    limits,
    telegram: {
      enabled: t.enabled,
      botId: text(
        t.botId,
        t.enabled ? /^[1-9][0-9]{0,19}$/ : /^$/,
        "setup_invalid_bot",
      ),
      generation: uint(t.generation),
    },
    songs,
  };
  check(
    result.origin !== result.operatorOrigin && result.owner !== result.grader,
    "setup_separate_operator_required",
  );
  check(!/^0x0+$/.test(result.communityId), "setup_invalid_community");
  return result;
}
export const learningSecretNames = [
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
] as const;
export type LearningSecretName = (typeof learningSecretNames)[number];
export function learningSecretValues(value: unknown, telegramEnabled: boolean) {
  const input = object(value);
  check(Object.keys(input).length > 0, "setup_empty_credentials");
  const output: Partial<Record<LearningSecretName, string>> = {};
  for (const [key, v] of Object.entries(input)) {
    check(
      learningSecretNames.includes(key as LearningSecretName) &&
        (key !== "TELEGRAM_BOT_TOKEN" || telegramEnabled),
      "setup_invalid_credential_field",
    );
    output[key as LearningSecretName] = text(
      v,
      /^[^\x00-\x20\x7f]{1,4096}$/,
      "setup_invalid_credential",
    );
  }
  return output;
}
export function communitySetupPlan(value: unknown, sourceDigest: string) {
  const s = communitySetupFrom(value),
    l = s.limits;
  hash(sourceDigest);
  const prefix = `pirate-${s.slug}`;
  const plan = {
    version: "community-setup/v1",
    sourceDigest,
    settings: s,
    execution: "held_for_review",
    resources: {
      ownerAccountId: s.accountId,
      communityWorker: prefix,
      learningWorker: `${prefix}-learning`,
      database: `${prefix}-db`,
      privateMedia: `${prefix}-media`,
      jobs: `${prefix}-jobs`,
      speechBudget: `${prefix}-speech`,
    },
    operatorBindings: {
      OPERATOR_PROFILE: "pirate-community-learning-v4",
      PAYMENT_CHAIN_ID: String(s.chainId),
      COMMUNITY_ID: s.communityId,
      RESULTS_V4_CONTRACT: s.resultsContract,
      SPONSOR_CAP_WEI: l.sponsorWei,
      SPONSOR_GAS_PRICE_WEI: l.gasPriceWei,
      SPONSOR_GAS_LIMIT: l.gasLimit,
      SPONSOR_DATA_FEE_WEI: l.dataFeeWei,
      ACTIVATION_TOTAL_CAP_WEI: l.activationTotalWei,
      ACTIVATION_ACCOUNT_CAP_WEI: l.activationAccountWei,
      ACTIVATION_MAX_ACCOUNTS: String(l.activationAccounts),
    },
    speechAdmission: {
      schema: "pirate.speech-admission/1",
      communityId: s.communityId,
      dailyUnits: l.speechDailyUnits,
      websiteStudyReserve: l.websiteReservedUnits,
      telegramDailyUnits: l.telegramDailyUnits,
      perAccountDailyUnits: l.perAccountDailyUnits,
      providerMonthlyBudgetUsdCents: l.providerMonthlyBudgetUsdCents,
      runtimeBinding: "coordinator-and-lane5-required",
    },
    secretReferences: (s.telegram.enabled
      ? learningSecretNames
      : (["ELEVENLABS_API_KEY"] as const)
    ).map((name) => ({ ...s.infisical, name })),
    contractPermissions: [
      {
        contract: s.resultsContract,
        role: "grader",
        address: s.grader,
        action: "verify-existing-authority",
      },
    ],
    checksRequired: [
      "independent-source-review",
      "Alchemy-dry-plan",
      "fresh-V4-runtime-profile-admission",
      "community-owned-account",
      "managed-secrets-readback",
      "grader-and-contract-origin-policy",
      "speech-reservation-integration",
      "first-real-song",
      "new-unallowlisted-MOSS-account",
      "fresh-browser-Study-Karaoke",
      "served-assets-and-health",
    ],
  };
  return { ...plan, id: digest(plan) };
}
