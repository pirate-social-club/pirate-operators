import type { Address, Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  consentAddress,
  consentDigest,
  consentUint64,
  publicationPurposes,
  type PublicationPurpose,
} from "../packages/protocol/publication-consent.ts";
import type { ConsentSourceV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { learningResultsV5Build } from "../packages/protocol/generated/learning-results-v5.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import {
  validateWeb2Configuration,
  type Web2CommunityConfig,
} from "../packages/community/web2-config-manifest.ts";
import {
  capturedFee,
  exact,
  record,
  source,
  type CapturedPublicationFeeV1,
} from "./publication-command-contract.ts";

export interface PublicationPolicySelection {
  target: Address;
  runtimeHash: Hex;
  permissionRevision: string;
  policyHash: Hex;
  maxGrantDurationSeconds: string;
  maxSubmissionDelaySeconds: string;
  dancePublicityPolicyHash: Hex;
  documents: {
    manifest: string;
    terms: string;
    disclosure: string;
    privacy: string;
    retention: string;
  };
}
/** Public immutable installed release, supplied by the deployment profile.
 * HTTP input never supplies this object, an RPC URL, an issuer or a fee. */
export interface PublicationAppRelease {
  schema: "pirate.publication-app-release/1";
  source: Omit<ConsentSourceV1, "releaseSelectionSha256">;
  registryAbiSha256: Hex;
  profile: Record<string, unknown>;
  configuration: Web2CommunityConfig;
  issuer: Address;
  operator: Address;
  fee: CapturedPublicationFeeV1;
  grantDurationSeconds: string;
  submitWindowSeconds: string;
  withdrawalWindowSeconds: string;
  policies: Partial<Record<PublicationPurpose, PublicationPolicySelection>>;
}
export const publicationSelectionHash = (r: PublicationAppRelease) => digest(r);
export const publicationSelectionSource = (
  r: PublicationAppRelease,
): ConsentSourceV1 =>
  source({ ...r.source, releaseSelectionSha256: publicationSelectionHash(r) });
export function parsePublicationRelease(value: unknown): PublicationAppRelease {
  const v = record(value);
  exact(v, [
    "schema",
    "source",
    "registryAbiSha256",
    "profile",
    "configuration",
    "issuer",
    "operator",
    "fee",
    "grantDurationSeconds",
    "submitWindowSeconds",
    "withdrawalWindowSeconds",
    "policies",
  ]);
  const copy = JSON.parse(canonical(v)) as PublicationAppRelease;
  check(
    new TextEncoder().encode(canonical(copy)).length <= 24576 &&
      copy.schema === "pirate.publication-app-release/1",
    "publication_release_invalid",
  );
  exact(record(copy.source), [
    "schema",
    "resultsVersion",
    "chainId",
    "communityId",
    "installationId",
    "directory",
    "directoryRuntimeHash",
    "registry",
    "registryRuntimeHash",
  ]);
  const s = publicationSelectionSource(copy),
    p = parseWeb2ProfileDocument(copy.profile);
  const c = validateWeb2Configuration(copy.configuration, p);
  check(
    canonical(c) === canonical(copy.configuration),
    "publication_release_configuration_changed",
  );
  consentAddress(copy.issuer);
  consentAddress(copy.operator);
  check(
    s.chainId === p.chainId &&
      s.communityId === p.communityId &&
      s.installationId === p.installationId &&
      s.directory === p.directory &&
      s.directoryRuntimeHash === p.directoryCodeHash &&
      c.learningRecords === s.registry &&
      copy.registryAbiSha256 === learningResultsV5Build.abiSha256,
    "publication_release_source_changed",
  );
  const fee = capturedFee(copy.fee);
  check(
    fee.chainId === s.chainId && fee.payer === copy.operator,
    "publication_release_fee_changed",
  );
  for (const field of [
    copy.grantDurationSeconds,
    copy.submitWindowSeconds,
    copy.withdrawalWindowSeconds,
  ])
    check(consentUint64(field) > 0n, "publication_release_window_invalid");
  const policies = record(copy.policies);
  check(
    Object.keys(policies).every((p) =>
      publicationPurposes.some((x) => x === p),
    ),
    "publication_release_purpose_invalid",
  );
  for (const [purpose, item] of Object.entries(policies)) {
    const q = record(item);
    exact(q, [
      "target",
      "runtimeHash",
      "permissionRevision",
      "policyHash",
      "maxGrantDurationSeconds",
      "maxSubmissionDelaySeconds",
      "dancePublicityPolicyHash",
      "documents",
    ]);
    consentAddress(q.target);
    consentDigest(q.runtimeHash);
    consentDigest(q.policyHash);
    const dance = consentDigest(q.dancePublicityPolicyHash, true);
    check(
      purpose.startsWith("dance-") ? BigInt(dance) > 0n : BigInt(dance) === 0n,
      "publication_release_dance_policy_invalid",
    );
    check(
      consentUint64(q.permissionRevision) > 0n &&
        consentUint64(q.maxGrantDurationSeconds) >=
          consentUint64(copy.grantDurationSeconds) &&
        consentUint64(q.maxSubmissionDelaySeconds) >=
          consentUint64(copy.submitWindowSeconds) &&
        consentUint64(copy.submitWindowSeconds) <=
          consentUint64(copy.grantDurationSeconds),
      "publication_release_window_invalid",
    );
    const docs = record(q.documents);
    exact(docs, ["manifest", "terms", "disclosure", "privacy", "retention"]);
    for (const raw of Object.values(docs)) {
      check(
        typeof raw === "string" && raw.length <= 2048,
        "publication_document_url_invalid",
      );
      const u = new URL(raw);
      check(
        !u.username &&
          !u.password &&
          !u.hash &&
          (u.protocol === "https:" ||
            (s.chainId === 31337 &&
              u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))),
        "publication_document_url_invalid",
      );
    }
  }
  return copy;
}
/** Retained entries are required for accepted originals and withdrawals after
 * active-profile replacement. Empty active is the explicit first-song profile. */
export class PublicationReleaseCatalog {
  private readonly retained = new Map<Hex, string>();
  readonly active: Hex | null;
  constructor(entries: readonly unknown[], active: Hex | null) {
    check(entries.length <= 128, "publication_release_catalog_too_large");
    for (const value of entries) {
      const r = parsePublicationRelease(value),
        hash = publicationSelectionHash(r),
        bytes = canonical(r);
      check(
        !this.retained.has(hash) || this.retained.get(hash) === bytes,
        "publication_release_changed",
      );
      this.retained.set(hash, bytes);
    }
    if (active !== null) {
      consentDigest(active);
      check(this.retained.has(active), "publication_release_missing");
    }
    this.active = active;
  }
  get(hash: Hex) {
    const bytes = this.retained.get(hash);
    check(bytes, "publication_retained_release_missing");
    return parsePublicationRelease(JSON.parse(bytes));
  }
  forOperatorSource(sourceSha256: Hex) {
    consentDigest(sourceSha256);
    const matches = [...this.retained.keys()]
      .map((hash) => this.get(hash))
      .filter((r) => digest(publicationSelectionSource(r)) === sourceSha256);
    check(matches.length === 1, "publication_operator_source_unselected");
    return matches[0]!;
  }
  fresh() {
    check(this.active, "publication_profile_disabled");
    return this.get(this.active);
  }
}
