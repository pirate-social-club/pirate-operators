import { Show } from "solid-js";
import { Button, Type } from "./ui.ts";
import type { StudyPublicationReceipt } from "../../../../packages/study/publication-view.ts";

export interface LearningPublicationView {
  state: "unbound" | "bound" | StudyPublicationReceipt["state"];
  receipt: StudyPublicationReceipt | null;
}
/** Completion slot follows the c7 ActivityCompletion panel composition. The
 * operator reports publication receipts, not centralized streak/earned-day data.
 * No amount, qualification, reward, or public success is inferred from a grade.
 */
export function StudyPublicationStatus(props: {
  value: LearningPublicationView | null;
  checking: boolean;
  onCheck(): void;
}) {
  const state = () => props.value?.state;
  return (
    <section
      aria-label="Result publication"
      class="space-y-3 rounded-xl border border-border-soft p-4"
    >
      <Type as="h2" variant="h3">
        Result publication
      </Type>
      <Show
        when={props.value}
        fallback={<p role="status">Checking this attempt…</p>}
      >
        <p role="status">
          {state() === "private"
            ? "This result was kept private."
            : state() === "published" && props.value?.receipt?.confirmed
              ? "This result is published."
              : state() === "failed"
                ? "This result's publication could not be confirmed."
                : "Publication is pending."}
        </p>
      </Show>
      <Button
        variant="secondary"
        disabled={props.checking}
        loading={props.checking}
        onClick={props.onCheck}
      >
        Check again
      </Button>
    </section>
  );
}
