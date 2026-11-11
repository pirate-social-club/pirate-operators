// c7 DanceFundedObjectives composition: prospective decentralized admission
// cannot display centralized drawing/payout facts which these ports do not own.
import { Button, Type } from "../design-system.ts";
import type { DanceObjectivesContext } from "./dance-preparation-api.ts";
export function DanceFundedObjectives(props: {
  readonly context: DanceObjectivesContext;
  readonly onAccept: () => void;
}) {
  return (
    <section aria-label="Captured Dance terms" class="space-y-4">
      <Type as="h2" variant="h3">
        Before you record
      </Type>
      <p>{props.context.consent.text}</p>
      <p>By continuing, you accept these captured terms for this take.</p>
      <Button
        class="w-full"
        disabled={props.context.consent.admission !== "admitted"}
        onClick={props.onAccept}
      >
        Accept and continue
      </Button>
      {props.context.consent.admission !== "admitted" && (
        <p role="status">Recording isn’t available for this dance right now.</p>
      )}
    </section>
  );
}
