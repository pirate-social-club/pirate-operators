import type { BoundPublicationGrantV1 } from "./publication-runtime-v1.ts";

/** Private practice has independent speech/privacy/budget admission. It never
 * fabricates a grant or becomes publication-bound after a later grant. */
export type PracticePublicationV1 =
  | {kind: "private"}
  | {kind: "publication-bound"; binding: BoundPublicationGrantV1};
