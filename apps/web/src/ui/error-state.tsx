import { Show } from "solid-js";
import { Button, buttonVariants, Card, CardContent, cn, Type } from "../design-system.ts";

export type ErrorStateTone = "blocked" | "retryable" | "resumable";

export interface ErrorStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export interface ErrorStateProps {
  title: string;
  description: string;
  tone?: ErrorStateTone;
  /** Resumable states may explain what is paused; blocked/retryable states omit it. */
  status?: string;
  primaryAction?: ErrorStateAction;
  secondaryAction?: ErrorStateAction;
}

/**
 * Locked error-state composite. Copy says what happened, distinguishes locked
 * from resumable, and ranks the primary recovery before exit. "Paused" belongs
 * only to resumable states; callers must not render a disabled action as status.
 */
export function ErrorState(props: ErrorStateProps) {
  return (
    <Card>
      <CardContent class="flex flex-col items-start gap-4 p-6">
        <Type as="h2" variant="h3">{props.title}</Type>
        <Type role="alert">{props.description}</Type>
        <Show when={props.tone === "resumable" && props.status}>
          <Type role="status" variant="caption">{props.status}</Type>
        </Show>
        <Show when={props.primaryAction || props.secondaryAction}>
          <div class="flex flex-wrap gap-3">
            <Show when={props.primaryAction}>
              {(action) => (
                <Show
                  when={action().href}
                  fallback={
                    <Button
                      disabled={action().disabled}
                      onClick={() => action().onClick?.()}
                    >
                      {action().label}
                    </Button>
                  }
                >
                  {(href) => (
                    <a
                      href={href()}
                      class={cn(buttonVariants(), "inline-flex items-center justify-center")}
                    >
                      {action().label}
                    </a>
                  )}
                </Show>
              )}
            </Show>
            <Show when={props.secondaryAction}>
              {(action) => (
                <Show
                  when={action().href}
                  fallback={
                    <Button
                      variant="outline"
                      disabled={action().disabled}
                      onClick={() => action().onClick?.()}
                    >
                      {action().label}
                    </Button>
                  }
                >
                  {(href) => (
                    <a
                      href={href()}
                      class={cn(buttonVariants({ variant: "outline" }), "inline-flex items-center justify-center")}
                    >
                      {action().label}
                    </a>
                  )}
                </Show>
              )}
            </Show>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
}
