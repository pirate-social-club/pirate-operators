// Shared profile is a proposal/readback, never admission or readiness by itself.
import type {LinuxCommunityProfileV1, DeploymentIdentity} from "./linux-profile.ts";
import {identityFrom} from "./linux-profile.ts";
import type {NamespaceAuthorityProof} from "../community-names/namespace-import.ts";
import {bindingKey} from "../community-names/namespace-import.ts";
import {fields, record, requireLinux, text, natural, reference, hash} from "./linux-input.ts";
import {linuxDraftFrom, publicOrigin, type LinuxDraftV2} from "./shared-linux-draft.ts";
import {infrastructureFrom, type SharedInfrastructure} from "./shared-linux-infrastructure.ts";
import {sharedNamespaceProofFrom} from "./shared-namespace-proof.ts";
export * from "./linux-input.ts";
export {linuxDraftFrom, publicOrigin, targetFrom, type LinuxDraftV2, type LinuxTarget, type SessionPolicy} from "./shared-linux-draft.ts";
export {identityFrom, type DeploymentIdentity};
export interface LinuxCommunityProfileV2 extends Omit<LinuxCommunityProfileV1, "schema" | "settings" | "namespace"> {
  schema: "pirate.community-linux-profile/2";
  settings: LinuxDraftV2;
  infrastructure: SharedInfrastructure;
  namespace: NamespaceAuthorityProof;
}
export function linuxProfileFrom(value: unknown): LinuxCommunityProfileV2 {
  requireLinux(record(value).schema === "pirate.community-linux-profile/2", "legacy_cutover_required", "Select profile v2 explicitly; retain V1 identity and journals for separately reviewed migration/recovery.");
  const o = fields(value, [
    "schema",
    "settings",
    "identity",
    "runtime",
    "learning",
    "namespace", "infrastructure",
  ]);
  requireLinux(
    o.schema === "pirate.community-linux-profile/2",
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
  const infrastructure = infrastructureFrom(o.infrastructure, identity, settings);
  const namespace = sharedNamespaceProofFrom(o.namespace);
  requireLinux(bindingKey(namespace.binding) === bindingKey(infrastructure.binding), "namespace_profile_binding", "Use the exact original shared installation/source binding.");
  let learning: LinuxCommunityProfileV2["learning"] = null;
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
    schema: "pirate.community-linux-profile/2",
    settings,
    identity,
    runtime: {
      sourceDigest: hash(runtime.sourceDigest),
      artifactDigest: hash(runtime.artifactDigest),
      recipe: reference(runtime.recipe),
      migrations,
    },
    learning,
    namespace,
    infrastructure,
  };
}
