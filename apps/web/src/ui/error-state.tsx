import { Show } from "solid-js";
import {
  Button,
  buttonVariants,
  Card,
  CardContent,
  cn,
  IconButton,
  IconX,
  Type,
} from "../design-system.ts";

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
  onExit?: () => void;
  exitLabel?: string;
}

/**
 * Locked error-state composite from PR94, extended with the route's existing X
 * exit so callers do not add a second exit button. Copy says what happened,
 * distinguishes locked from resumable, and ranks the primary recovery.
 */
export function ErrorState(props: ErrorStateProps) {
  return (
    <Card>
      <CardContent class="relative flex flex-col items-start gap-4 p-6">
        <Show when={props.onExit}>
          <IconButton
            aria-label={props.exitLabel ?? "Exit"}
            class="absolute right-4 top-4"
            onClick={() => props.onExit?.()}
            variant="ghost"
          >
            <IconX class="size-5" />
          </IconButton>
        </Show>
        <Type as="h2" class="pr-12" variant="h3">{props.title}</Type>
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
