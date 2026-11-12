// Proposed source, UNAPPLIED. Same issuer/operator keys and signature domain.
import type { Address, Hex } from "viem";
import {
  check,
  digest,
  verify,
  type Signed,
  type Ticket,
} from "../packages/protocol/index.ts";
import type { ResultsTarget } from "./learning-contract.ts";

export interface KaraokePreparation {
  version: 1;
  target: ResultsTarget;
  authorizationIssuedAt: number;
}
export interface KaraokePrepared {
  version: 1;
  ticketId: Hex;
  ticketHash: Hex;
  preparationHash: Hex;
}
export const preparationBody = (
  ticket: Signed<Ticket>,
  preparation: KaraokePreparation,
): KaraokePrepared => ({
  version: 1,
  ticketId: ticket.body.ticketId,
  ticketHash: digest(ticket) as Hex,
  preparationHash: digest(preparation) as Hex,
});
export async function verifyPrepared(
  signed: Signed<KaraokePrepared>,
  ticket: Signed<Ticket>,
  preparation: KaraokePreparation,
  operator: Address,
  chainId: number,
) {
  const actual = await verify(signed, "karaoke_prepared_v1", operator, chainId);
  check(
    digest(actual) === digest(preparationBody(ticket, preparation)),
    "karaoke_preparation_ack_mismatch",
  );
}

/** Server-only metadata, committed together with the original reservation.
 * No callback/client field is persisted. No migration or backfill inference. */
export interface KaraokeRecoveryScope {
  version: 1;
  accountId: string;
  wallet: Address;
  postId: Hex;
  communityId: string;
  community: Address;
  issuer: Address;
  operator: Address;
  operatorOrigin: string;
  paymentChainId: number;
  signatureChainId: number;
  payments: string;
  token: string;
  quoteHash: Hex;
  authorizationId: Hex;
  preparation: KaraokePreparation;
}
