import type { DANCE_WIRE_PROPOSAL } from "./wire-proposal.ts";
/** Exact proposed tuple FIELD types. BigInt conversion is explicit. These
 * declarations do not implement/admit the final ABI or keccak hash. */
type Hex = `0x${string}`;
type Ordered = typeof DANCE_WIRE_PROPOSAL.orderedTuples;
type Scalar<T extends string> = T extends "bool"
  ? boolean
  : T extends "address" | "bytes32"
    ? Hex
    : T extends `uint${string}`
      ? bigint
      : T extends "Song"
        ? SongTuple
        : T extends "Reference"
          ? ReferenceTuple
          : T extends "Offer"
            ? OfferTuple
            : T extends "Capture"
              ? CaptureTuple
              : T extends "Consent"
                ? ConsentTuple
                : T extends "Submission"
                  ? SubmissionTuple
                  : T extends "Decision"
                    ? DecisionTuple
                    : never;
type Fields<T extends readonly string[]> = {
  [F in T[number] as F extends `${string} ${infer Name}`
    ? Name
    : never]: F extends `${infer Kind} ${string}` ? Scalar<Kind> : never;
};
export type SongTuple = Fields<Ordered["Song"]>;
export type ReferenceTuple = Fields<Ordered["Reference"]>;
export type OfferTuple = Fields<Ordered["Offer"]>;
export type CaptureTuple = Fields<Ordered["Capture"]>;
export type ConsentTuple = Fields<Ordered["Consent"]>;
export type SubmissionTuple = Fields<Ordered["Submission"]>;
export type DecisionTuple = Fields<Ordered["Decision"]>;
type Mutations = typeof DANCE_WIRE_PROPOSAL.mutationTuples;
export type DanceMutationName = {
  [K in keyof Mutations]: Mutations[K] extends readonly string[] ? K : never;
}[keyof Mutations];
export type DanceMutation<K extends DanceMutationName> =
  Mutations[K] extends readonly string[] ? Fields<Mutations[K]> : never;
export interface FrozenDanceWireCommand<K extends DanceMutationName> {
  version: "pirate.dance-command/1";
  operation: K;
  commandId: Hex;
  authenticatedCaller: Hex;
  payload: DanceMutation<K>;
}
