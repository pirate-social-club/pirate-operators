import { Button, Type } from "./ui.ts";

/** c7 ActivityCompletion panel composition with actual operator record state.
 * It does not infer qualification, a payout, or canonical confirmation.
 */
export function KaraokeCompletionStatus(props: {
  state: string | null;
  onCheck(): void;
}) {
  return (
    <section
      aria-label="Result publication"
      class="space-y-3 rounded-xl border border-border-soft p-4"
    >
      <Type as="h2" variant="h3">
        Result publication
      </Type>
      <p role="status">
        {props.state
          ? `Publication status: ${props.state}.`
          : "Publication status is unavailable."}
      </p>
      <Button variant="secondary" onClick={props.onCheck}>
        Check again
      </Button>
    </section>
  );
}
