// Commitment construction only; callers must supply independently verified facts.
// This module performs no DNS/HTTP observation and cannot grant verification.
import { type Address, type Hex } from "viem";
import { canonical, exact, hashText, insist, object } from "./common.ts";
import { address, httpsOrigin } from "./manifest-core.ts";
import { sharedBytes32 } from "./shared-identity.ts";
import {
  validateWeb2Profile,
  type Web2DirectoryProfile,
} from "./web2-directory.ts";

const uint64 = (value: unknown): string => {
  insist(
    typeof value === "string" &&
      /^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value) &&
      BigInt(value) < 2n ** 64n,
    "invalid_evidence_integer",
  );
  return value;
};
export interface Web2Evidence {
  schema: "pirate.web2-address-evidence/1";
  chainId: 6343 | 31337;
  directory: Address;
  communityId: Hex;
  installationId: Hex;
  controller: Address;
  controllerRevision: string;
  origin: string;
  originRevision: string;
  method: "dns-txt" | "https";
  challengeDigest: Hex;
  observationDigest: Hex;
  observedAt: string;
}
export function web2EvidenceCommitment(
  profile: Web2DirectoryProfile,
  input: unknown,
) {
  const p = validateWeb2Profile(profile),
    o = object(input);
  exact(o, [
    "schema",
    "chainId",
    "directory",
    "communityId",
    "installationId",
    "controller",
    "controllerRevision",
    "origin",
    "originRevision",
    "method",
    "challengeDigest",
    "observationDigest",
    "observedAt",
  ]);
  insist(
    o.schema === "pirate.web2-address-evidence/1" &&
      o.chainId === p.chainId &&
      o.directory === p.directory &&
      o.communityId === p.communityId &&
      o.installationId === p.installationId,
    "evidence_binding_mismatch",
  );
  insist(
    o.method === "dns-txt" || o.method === "https",
    "unsupported_address_proof",
  );
  const controllerRevision = uint64(o.controllerRevision),
    originRevision = uint64(o.originRevision);
  insist(
    controllerRevision !== "0" && originRevision !== "0",
    "invalid_evidence_revision",
  );
  const evidence: Web2Evidence = {
    schema: "pirate.web2-address-evidence/1",
    chainId: p.chainId,
    directory: p.directory,
    communityId: p.communityId,
    installationId: p.installationId,
    controller: address(o.controller),
    controllerRevision,
    origin: httpsOrigin(o.origin),
    originRevision,
    method: o.method,
    challengeDigest: sharedBytes32(o.challengeDigest),
    observationDigest: sharedBytes32(o.observationDigest),
    observedAt: uint64(o.observedAt),
  };
  Object.freeze(evidence);
  return Object.freeze({ evidence, sha256: hashText(canonical(evidence)) });
}
