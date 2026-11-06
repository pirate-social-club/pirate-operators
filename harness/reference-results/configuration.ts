// Independent supported community configuration schema. No production validator.
import { requireFact } from "./checks.ts";
import {
  exactDocument,
  documentText,
  documentInteger,
  documentHash,
  documentAddress,
  documentDecimal,
  documentOrigin,
  admissionPolicy,
} from "./document-rules.ts";
export function configurationDocument(c: Record<string, any>) {
  exactDocument(c, [
    "schema",
    "chainId",
    "directory",
    "communityId",
    "registry",
    "tld",
    "configurationRevision",
    "postsContract",
    "controller",
    "publisher",
    "operatorPayments",
    "learningRecords",
    "app",
    "feed",
    "policies",
    "publisherRevocations",
  ]);
  requireFact(
    c.schema === "pirate.community-config/1" &&
      [6343, 31337].includes(c.chainId),
    "unsupported_configuration",
  );
  for (const field of [
    "directory",
    "registry",
    "postsContract",
    "controller",
    "publisher",
  ])
    documentAddress(c[field]);
  documentAddress(c.operatorPayments, true);
  documentAddress(c.learningRecords, true);
  documentHash(c.communityId);
  documentInteger(c.configurationRevision, 1);
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  requireFact(
    label.test(documentText(c.tld, 63)),
    "invalid_configuration_label",
  );
  exactDocument(c.app, [
    "label",
    "tokenGeneration",
    "origin",
    "httpsAlias",
    "hnsIngress",
  ]);
  requireFact(
    label.test(documentText(c.app.label, 63)) &&
      c.app.tokenGeneration === "0" &&
      c.app.hnsIngress === "none",
    "unsupported_configuration_app",
  );
  const origin = documentOrigin(c.app.origin);
  if (c.app.httpsAlias !== null) documentOrigin(c.app.httpsAlias);
  exactDocument(c.feed, ["endpoint", "signingKeyId"]);
  requireFact(
    documentText(c.feed.endpoint, 1024) === origin + "/api/feed",
    "invalid_configuration_feed",
  );
  documentText(c.feed.signingKeyId, 128);
  exactDocument(c.policies, ["admission", "moderationSigner"]);
  admissionPolicy(c.policies.admission);
  documentAddress(c.policies.moderationSigner);
  requireFact(
    Array.isArray(c.publisherRevocations) &&
      c.publisherRevocations.length <= 256,
    "invalid_configuration_revocations",
  );
  for (const r of c.publisherRevocations) {
    exactDocument(r, ["postsContract", "publisher", "fromBlock"]);
    documentAddress(r.postsContract);
    documentAddress(r.publisher);
    documentDecimal(r.fromBlock);
  }
}
