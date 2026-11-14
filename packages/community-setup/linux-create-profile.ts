// Explicit signed local create-only successor. V2 decoder bodies/bytes are retained.
// Validation provenance: shared-linux-draft.ts and shared-linux-profile.ts.
import {storageProfileFrom} from "./storage.ts";
import {fields, record, requireLinux, text, natural, reference, hash} from "./linux-input.ts";
import {linuxDraftFrom, publicOrigin, targetFrom, type LinuxDraftV2} from "./shared-linux-draft.ts";
import {linuxProfileFrom, identityFrom, type LinuxCommunityProfileV2, type DeploymentIdentity} from "./shared-linux-profile.ts";
import {infrastructureFrom} from "./shared-linux-infrastructure.ts";
import {sharedNamespaceProofFrom} from "./shared-namespace-proof.ts";
import {bindingKey} from "../community-names/namespace-import.ts";
export interface LinuxCreateDraftV3 extends Omit<LinuxDraftV2, "version" | "mode" | "target" | "storage" | "recovery"> {
  version: 3;
  mode: "create";
  target: {kind: "local-linux"};
  storage: Pick<LinuxDraftV2["storage"], "publicMedia" | "privateData">;
}
export interface LinuxCreateProfileV3 extends Omit<LinuxCommunityProfileV2, "schema" | "settings"> {
  schema: "pirate.community-linux-profile/3";
  settings: LinuxCreateDraftV3;
}
export type OriginalLinuxProfile = LinuxCommunityProfileV2 | LinuxCreateProfileV3;
export type OriginalLinuxDraft = LinuxDraftV2 | LinuxCreateDraftV3;
export function originalLinuxDraftFrom(value: unknown): OriginalLinuxDraft {
  return record(value).version === 3 ? linuxCreateDraftFrom(value) : linuxDraftFrom(value);
}
export function originalLinuxProfileFrom(value: unknown): OriginalLinuxProfile {
  return record(value).schema === "pirate.community-linux-profile/3" ? linuxCreateProfileFrom(value) : linuxProfileFrom(value);
}
export function linuxCreateDraftFrom(value: unknown): LinuxCreateDraftV3 {
  const o = fields(value, [
    "version", "infrastructure",
    "mode",
    "name",
    "slug",
    "origin",
    "target",
    "namespace",
    "features",
    "services",
    "storage",
    "limits",
  ]);
  requireLinux(
    o.version === 3 && o.infrastructure === "pirate.shared-directory/2" && o.mode === "create",
    "profile_version",
    "Select the explicit local create-only profile v3; retained profiles are never converted.",
  );
  const slug = text(o.slug, 30);
  requireLinux(
    /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug),
    "invalid_slug",
    "Use 3–30 lowercase letters, numbers and hyphens for the community identifier.",
  );
  const ns = fields(o.namespace, ["tld"]),
    tld = text(ns.tld, 63);
  requireLinux(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tld),
    "namespace_required",
    "Enter the controlled TLD to import, without dots. Hosting does not prove its authority.",
  );
  const f = fields(o.features, [
    "learning",
    "karaoke",
    "media",
    "dance",
    "telegram",
  ]);
  requireLinux(
    Object.values(f).every((v) => typeof v === "boolean") &&
      (!f.karaoke || f.learning) &&
      (!f.dance || f.media) &&
      (!f.telegram || f.learning),
    "feature_dependencies",
    "Karaoke and connected Telegram require Learning; Dance requires private media.",
  );
  const services = fields(o.services, [
    "publicationProfile",
    "learningProfile",
  ]);
  requireLinux(
    f.learning
      ? typeof services.learningProfile === "string"
      : services.learningProfile === null,
    "learning_profile_required",
    "Select an available Learning profile, or turn Learning off.",
  );
  const s = fields(o.storage, ["publicMedia", "privateData"]),
    privateData = fields(s.privateData, ["provider"]);
  const publicMedia = storageProfileFrom(s.publicMedia);
  requireLinux(
    publicMedia.role === "public-ipfs" &&
      privateData.provider === "local-volume",
    "storage_roles",
    "Keep public IPFS media and private persistent data separate; backup is deferred for this schema.",
  );
  const l = fields(o.limits, [
    "speechDaily",
    "websiteReserved",
    "perAccountDaily",
    "monthlyUsdCents",
  ]);
  const limits = {
    speechDaily: natural(l.speechDaily, 1000000),
    websiteReserved: natural(l.websiteReserved, 1000000),
    perAccountDaily: natural(l.perAccountDaily, 1000000),
    monthlyUsdCents: natural(l.monthlyUsdCents, 100000000),
  };
  requireLinux(
    limits.websiteReserved <= limits.speechDaily &&
      limits.perAccountDaily <= limits.speechDaily &&
      (!f.learning || limits.speechDaily > 0),
    "speech_limits",
    "Reserve website capacity within the community daily limit; Learning needs a positive allowance.",
  );
  const target = targetFrom(o.target);
  requireLinux(target.kind === "local-linux", "create_target", "Run this create-only profile on its own local Linux host.");
  return {
    version: 3,
    infrastructure: "pirate.shared-directory/2",
    mode: "create",
    name: text(o.name, 80),
    slug,
    origin: publicOrigin(o.origin),
    target,
    namespace: { tld },
    features: f as LinuxCreateDraftV3["features"],
    services: {
      publicationProfile: reference(services.publicationProfile),
      learningProfile: f.learning ? reference(services.learningProfile) : null,
    },
    storage: { publicMedia, privateData: { provider: "local-volume" } },
    limits,
  };
}

export function linuxCreateRuntimeFrom(value: unknown): LinuxCreateProfileV3["runtime"] {
  const runtime = fields(value, [
      "sourceDigest",
      "artifactDigest",
      "recipe",
      "migrations",
    ]),
    migration = record(runtime.migrations);
  requireLinux(
    Object.keys(migration).length > 0 &&
      Object.keys(migration).length <= 200 &&
      Object.keys(migration).every((k) => /^\d{4}_[a-z0-9_]+\.sql$/.test(k)),
    "migration_identity",
    "The backend must retain the exact selected migration manifest.",
  );
  const migrations = Object.fromEntries(
    Object.entries(migration).map(([k, v]) => [k, hash(v)]),
  );
  return {sourceDigest: hash(runtime.sourceDigest), artifactDigest: hash(runtime.artifactDigest), recipe: reference(runtime.recipe), migrations};
}

export function linuxCreateLearningFrom(value: unknown, settings: LinuxCreateDraftV3, identity: DeploymentIdentity): LinuxCreateProfileV3["learning"] {
  let learning: LinuxCreateProfileV3["learning"] = null;
  if (settings.features.learning) {
    const l = fields(value, [
      "profileId",
      "configurationDigest",
      "operatorOrigin",
      "communityOrigin",
      "resultsContract",
      "chainId",
      "issuer",
      "operator",
      "codeHash",
      "secretRefs",
      "activation",
    ]);
    requireLinux(
      l.profileId === settings.services.learningProfile &&
        (l.chainId === 6343 || l.chainId === 31337) &&
        typeof l.resultsContract === "string" &&
        /^0x[0-9a-f]{40}$/.test(l.resultsContract) &&
        !/^0x0+$/.test(l.resultsContract),
      "learning_identity",
      "Discover a compatible verified testnet Learning configuration.",
    );
    requireLinux(
      Boolean(identity.resources.learning),
      "learning_resource",
      "The plan must include the selected Learning operator.",
    );
    requireLinux(
      l.communityOrigin === settings.origin,
      "learning_origin",
      "The selected authorization contract must name this application's exact origin.",
    );
    const refs = fields(l.secretRefs, ["speech", "operator", "issuer"]),
      a = fields(l.activation, [
        "totalWei",
        "accountWei",
        "accounts",
        "gasPriceWei",
        "gasLimit",
        "dataFeeWei",
      ]);
    const wei = (v: unknown) => {
      requireLinux(
        typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v),
        "activation_limits",
        "The backend must retain bounded integer activation fee limits.",
      );
      return v;
    };
    const activation = {
      totalWei: wei(a.totalWei),
      accountWei: wei(a.accountWei),
      accounts: natural(a.accounts, 1000000),
      gasPriceWei: wei(a.gasPriceWei),
      gasLimit: wei(a.gasLimit),
      dataFeeWei: wei(a.dataFeeWei),
    };
    requireLinux(
      activation.accounts > 0 &&
        BigInt(activation.gasPriceWei) > 0n &&
        BigInt(activation.gasLimit) > 0n &&
        2n *
          (BigInt(activation.gasPriceWei) * BigInt(activation.gasLimit) +
            BigInt(activation.dataFeeWei)) <=
          BigInt(activation.accountWei) &&
        BigInt(activation.accountWei) <= BigInt(activation.totalWei),
      "activation_limits",
      "Activation must fit both the retained per-account and total caps.",
    );
    const address = (v: unknown) => {
      requireLinux(
        typeof v === "string" &&
          /^0x[0-9a-f]{40}$/.test(v) &&
          !/^0x0+$/.test(v),
        "learning_authority",
        "Discover the original issuer/operator addresses instead of entering replacement keys.",
      );
      return v;
    };
    learning = {
      profileId: reference(l.profileId),
      configurationDigest: hash(l.configurationDigest),
      operatorOrigin: publicOrigin(l.operatorOrigin),
      communityOrigin: settings.origin,
      resultsContract: l.resultsContract,
      chainId: l.chainId,
      issuer: address(l.issuer),
      operator: address(l.operator),
      codeHash: hash(l.codeHash),
      secretRefs: {
        speech: reference(refs.speech),
        operator: reference(refs.operator),
        issuer: reference(refs.issuer),
      },
      activation,
    };
  } else
    requireLinux(
      value === null,
      "unexpected_learning",
      "Turn Learning on before selecting its configuration.",
    );
  return learning;
}

export function linuxCreateProfileFrom(value: unknown): LinuxCreateProfileV3 {
  requireLinux(record(value).schema === "pirate.community-linux-profile/3", "profile_version", "Select create-only profile v3 explicitly; retained V2 originals stay on their original path.");
  const o = fields(value, [
    "schema",
    "settings",
    "identity",
    "runtime",
    "learning",
    "namespace", "infrastructure",
  ]);
  requireLinux(
    o.schema === "pirate.community-linux-profile/3",
    "profile_version",
    "Import a supported Linux community profile.",
  );
  const settings = linuxCreateDraftFrom(o.settings),
    identity = identityFrom(o.identity),
    runtime = linuxCreateRuntimeFrom(o.runtime);
  const infrastructure = infrastructureFrom(o.infrastructure, identity, settings);
  requireLinux(infrastructure.mapping.origin === "new-shared", "fresh_create_mapping_required", "V3 creates only a genuinely new mapped installation; retained V2 requires its original codec.");
  const namespace = sharedNamespaceProofFrom(o.namespace);
  requireLinux(bindingKey(namespace.binding) === bindingKey(infrastructure.binding), "namespace_profile_binding", "Use the exact original shared installation/source binding.");
  const learning = linuxCreateLearningFrom(o.learning, settings, identity);
  return {
    schema: "pirate.community-linux-profile/3",
    settings,
    identity,
    runtime,
    learning,
    namespace,
    infrastructure,
  };
}
