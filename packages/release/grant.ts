import {
  amount,
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import type { ReleaseGrant } from "./authority.ts";

export function releaseGrantDigest(grant: ReleaseGrant) {
  const { sha256, pins, registration, ...scope } = grant;
  const { sha256: pinHash, ...pinBounds } = pins;
  const { sha256: registrationHash, ...registrationBounds } = registration;
  return hashJson({
    ...scope,
    pins: pinBounds,
    registration: registrationBounds,
  });
}
/** Reviewed server configuration only; request bodies never select a grant. */
export function validateReleaseGrant(input: unknown): ReleaseGrant {
  const g = object(input);
  exact(g, [
    "sha256",
    "communityId",
    "communityOrigin",
    "configurationRevision",
    "publisher",
    "contentSha256",
    "recipient",
    "expiresAt",
    "pins",
    "registration",
  ]);
  const pins = object(g.pins),
    registration = object(g.registration);
  exact(pins, ["sha256", "period", "maximumAdds"]);
  exact(registration, [
    "sha256",
    "period",
    "operator",
    "recipient",
    "contentSha256",
    "maximumGas",
    "maximumGasPrice",
    "maximumTotalFee",
    "expiresAt",
    "codeHashes",
  ]);
  const code = object(registration.codeHashes);
  exact(code, ["workflow", "nft", "registry"]);
  const grant: ReleaseGrant = {
    sha256: bytes32(g.sha256),
    communityId: bytes32(g.communityId),
    communityOrigin: httpsOrigin(g.communityOrigin),
    configurationRevision: integer(
      g.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    publisher: address(g.publisher),
    contentSha256: bytes32(g.contentSha256),
    recipient: address(g.recipient),
    expiresAt: integer(g.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    pins: {
      sha256: bytes32(pins.sha256),
      period: text(pins.period, 64),
      maximumAdds: integer(pins.maximumAdds, 5, 5),
    },
    registration: {
      sha256: bytes32(registration.sha256),
      period: text(registration.period, 64),
      operator: address(registration.operator),
      recipient: address(registration.recipient),
      contentSha256: bytes32(registration.contentSha256),
      maximumGas: amount(registration.maximumGas).toString(),
      maximumGasPrice: amount(registration.maximumGasPrice).toString(),
      maximumTotalFee: amount(registration.maximumTotalFee).toString(),
      expiresAt: integer(registration.expiresAt, 1, Number.MAX_SAFE_INTEGER),
      codeHashes: {
        workflow: bytes32(code.workflow),
        nft: bytes32(code.nft),
        registry: bytes32(code.registry),
      },
    },
  };
  insist(
    grant.sha256 === releaseGrantDigest(grant) &&
      grant.pins.sha256 === grant.sha256 &&
      grant.registration.sha256 === grant.sha256 &&
      grant.registration.recipient === grant.recipient &&
      grant.registration.contentSha256 === grant.contentSha256 &&
      grant.registration.expiresAt === grant.expiresAt &&
      grant.pins.period === grant.registration.period,
    "release_grant_binding_invalid",
    503,
  );
  insist(
    amount(grant.registration.maximumGas) > 0n &&
      amount(grant.registration.maximumGas) <= 10000000n &&
      amount(grant.registration.maximumGasPrice) > 0n &&
      amount(grant.registration.maximumGasPrice) <= 1000000000000n &&
      amount(grant.registration.maximumTotalFee) > 0n &&
      amount(grant.registration.maximumTotalFee) <= 100000000000000000n,
    "release_grant_exceeds_test_bounds",
    503,
  );
  return grant;
}
