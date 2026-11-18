import type { Address } from "viem";
import { check } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { PublicationReadRpc } from "./publication-command-rpc.ts";
import { publicationCommandFetch, type PublicationCommandApiV1 } from "./publication-command-api.ts";
import { record } from "./publication-command-contract.ts";
import {
  PublicationReleaseCatalog,
  publicationSelectionSource,
} from "./publication-app-selection.ts";

/** Concrete retained-source dispatch over the already admitted operator API.
 * An unverified header can select only an installed whitelist entry. The API
 * then verifies its exact issuer signature/body/source before any mutation.
 * Root still owns the common HTTP mount, Store, managed wallet and read RPC. */
export async function publicationInstalledOperatorFetch(
  request: Request,
  ports: {
    catalog: PublicationReleaseCatalog;
    operatorAddress: Address;
    store: ResultStore;
    read: PublicationReadRpc;
    clock: () => number;
    assertAcceptCurrent?: PublicationCommandApiV1["assertAcceptCurrent"];
  },
) {
  if (
    ![
      "/publication/v1/fence",
      "/publication/v1/accept",
      "/publication/v1/reconcile",
    ].includes(new URL(request.url).pathname)
  )
    return null;
  check(
    ports.catalog instanceof PublicationReleaseCatalog,
    "publication_release_catalog_required",
  );
  const header = request.headers.get("x-pirate-publication-authorization");
  check(header && header.length <= 4096, "publication_issuer_required");
  const envelope = record(record(JSON.parse(header)).request);
  const release = ports.catalog.forOperatorSource(
    consentDigest(envelope.sourceSha256),
  );
  check(
    release.operator === ports.operatorAddress.toLowerCase(),
    "publication_operator_changed",
  );
  return publicationCommandFetch(request, {
    issuer: {
      source: publicationSelectionSource(release),
      issuer: release.issuer,
      operator: release.operator,
    },
    selectedFee: release.fee,
    store: ports.store,
    read: ports.read,
    clock: ports.clock,
    assertAcceptCurrent: ports.assertAcceptCurrent,
  });
}
