// Resolved versioned Linux profile; configuration is never readiness or authority.
// Existing Cloudflare CommunitySetupV1 remains unchanged and is not required.
export * from "./linux-input.ts";
export * from "./linux-draft.ts";
import {
  fields,
  record,
  requireLinux,
  text,
  natural,
  reference,
  hash,
  publicOrigin,
} from "./linux-input.ts";
import { linuxDraftFrom, type LinuxDraftV1 } from "./linux-draft.ts";
export interface DeploymentIdentity {
  deploymentId: string;
  communityId: string;
  resources: Record<string, string>;
}
export function identityFrom(value: unknown): DeploymentIdentity {
  const o = fields(value, ["deploymentId", "communityId", "resources"]),
    resources = record(o.resources);
  requireLinux(
    Object.keys(resources).length >= 4 &&
      Object.keys(resources).length <= 32 &&
      ["application", "database", "privateData", "jobs"].every(
        (key) => key in resources,
      ),
    "resource_identity",
    "The backend must discover the application, database, private data and job identities.",
  );
  const parsed = Object.fromEntries(
    Object.entries(resources).map(([key, v]) => [reference(key), reference(v)]),
  );
  return {
    deploymentId: reference(o.deploymentId),
    communityId: hash(o.communityId),
    resources: parsed,
  };
}
export interface LinuxCommunityProfileV1 {
  schema: "pirate.community-linux-profile/1";
  settings: LinuxDraftV1;
  identity: DeploymentIdentity;
  runtime: {
    sourceDigest: string;
    artifactDigest: string;
    recipe: string;
    migrations: Record<string, string>;
  };
  learning: null | {
    profileId: string;
    configurationDigest: string;
    operatorOrigin: string;
    communityOrigin: string;
    resultsContract: string;
    chainId: 6343 | 31337;
    issuer: string;
    operator: string;
    codeHash: string;
    secretRefs: { speech: string; operator: string; issuer: string };
    activation: {
      totalWei: string;
      accountWei: string;
      accounts: number;
      gasPriceWei: string;
      gasLimit: string;
      dataFeeWei: string;
    };
  };
  namespace: {
    authorityRef: string;
    tld: string;
    scope: "tld" | "sld";
    permittedSlds: string[];
    excludedSlds: string[];
    evidenceDigest: string;
  };
}
export function linuxProfileFrom(value: unknown): LinuxCommunityProfileV1 {
  const o = fields(value, [
    "schema",
    "settings",
    "identity",
    "runtime",
    "learning",
    "namespace",
  ]);
  requireLinux(
    o.schema === "pirate.community-linux-profile/1",
    "profile_version",
    "Import a supported Linux community profile.",
  );
  const settings = linuxDraftFrom(o.settings),
    identity = identityFrom(o.identity),
    runtime = fields(o.runtime, [
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
  const ns = fields(o.namespace, [
    "authorityRef",
    "tld",
    "scope",
    "permittedSlds",
    "excludedSlds",
    "evidenceDigest",
  ]);
  requireLinux(
    ns.tld === settings.namespace.tld &&
      ["tld", "sld"].includes(String(ns.scope)) &&
      Array.isArray(ns.permittedSlds) &&
      (ns.scope === "tld"
        ? ns.permittedSlds.length === 0
        : ns.permittedSlds.length > 0) &&
      ns.permittedSlds.length <= 100 &&
      ns.permittedSlds.every(
        (v) =>
          typeof v === "string" &&
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v) &&
          `${v}.${ns.tld}` !== "kaya.pirate",
      ) &&
      new Set(ns.permittedSlds).size === ns.permittedSlds.length,
    "namespace_scope",
    "Use only the exact SLD scope returned by the authority adapter.",
  );
  requireLinux(
    Array.isArray(ns.excludedSlds) &&
      ns.excludedSlds.length <= 100 &&
      ns.excludedSlds.every(
        (v) =>
          typeof v === "string" &&
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v) &&
          !(ns.permittedSlds as string[]).includes(v),
      ) &&
      (ns.tld !== "pirate" || ns.excludedSlds.includes("kaya")),
    "namespace_exclusions",
    "Retain reserved exclusions, including kaya.pirate, in the actual issuance scope.",
  );
  let learning: LinuxCommunityProfileV1["learning"] = null;
  if (settings.features.learning) {
    const l = fields(o.learning, [
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
      o.learning === null,
      "unexpected_learning",
      "Turn Learning on before selecting its configuration.",
    );
  return {
    schema: "pirate.community-linux-profile/1",
    settings,
    identity,
    runtime: {
      sourceDigest: hash(runtime.sourceDigest),
      artifactDigest: hash(runtime.artifactDigest),
      recipe: reference(runtime.recipe),
      migrations,
    },
    learning,
    namespace: {
      authorityRef: reference(ns.authorityRef),
      tld: settings.namespace.tld,
      scope: ns.scope as "tld" | "sld",
      permittedSlds: ns.permittedSlds as string[],
      excludedSlds: ns.excludedSlds as string[],
      evidenceDigest: hash(ns.evidenceDigest),
    },
  };
}
