import type { Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { publicationIssuerBody, type PublicationIssuerV1 } from "./publication-command-auth.ts";
import { exact, record, same, type CapturedPublicationFeeV1 } from "./publication-command-contract.ts";
import { acceptPublicationCommand, inhibitPublication, readPublicationJob } from "./publication-command-operator.ts";
import { reconcilePublicationCommand } from "./publication-command-reconcile.ts";
import type { PublicationReadRpc } from "./publication-command-rpc.ts";

export interface PublicationCommandApiV1 {
  /** Root-owned trusted installed or retained-source lookup, not HTTP input. */
  issuer: PublicationIssuerV1;
  selectedFee?: CapturedPublicationFeeV1;
  store: ResultStore;
  read: PublicationReadRpc;
  clock: () => number;
}
/** Not mounted by this packet. Root owns actual caller/session/profile routing.
 * No endpoint in this module can sign, allocate or broadcast a transaction. */
export async function publicationCommandFetch(request: Request, ports: PublicationCommandApiV1) {
  const path = new URL(request.url).pathname;
  if (!["/publication/v1/fence","/publication/v1/accept","/publication/v1/reconcile"].includes(path))
    return null;
  const value = await publicationIssuerBody(request,ports.issuer,ports.clock);
  const reply = (body: unknown) => Response.json(body,{headers:{"cache-control":"no-store"}});
  if (path === "/publication/v1/fence")
    return reply(inhibitPublication(ports.store,value,ports.issuer));
  if (path === "/publication/v1/accept") {
    const accepted = acceptPublicationCommand(ports.store,value,ports.issuer,ports.selectedFee);
    return reply(await reconcilePublicationCommand(ports.store,accepted.commandId,ports.read));
  }
  const body = record(value); exact(body,["commandId"]);
  const id = consentDigest(body.commandId) as Hex;
  const job = readPublicationJob(ports.store,id);
  check(job && same(job.command.source,ports.issuer.source), "publication_source_changed");
  return reply(await reconcilePublicationCommand(ports.store,id,ports.read));
}
