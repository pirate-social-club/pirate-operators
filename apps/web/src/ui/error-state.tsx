import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Button, buttonVariants, cn, IconWarningCircle, Type } from "../design-system.ts";

export type ErrorStateTone = "blocked" | "retryable" | "resumable";

export interface ErrorStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export interface ErrorStateProps {
  title: string;
  description?: string;
  tone?: ErrorStateTone;
  /** Resumable states may explain what is paused; blocked/retryable states omit it. */
  status?: string;
  primaryAction?: ErrorStateAction;
  secondaryAction?: ErrorStateAction;
  headingLevel?: "h1" | "h2";
  centered?: boolean;
  error?: boolean;
  icon?: JSX.Element;
}

/**
 * Content-only error state. Route shells own the page header, exit control and
 * footer actions; inline pages such as Wallet may render the actions here.
 */
export function ErrorState(props: ErrorStateProps) {
  const failure = () => props.error === true;
  return (
    <div
      role={failure() ? "alert" : undefined}
      class={cn(
        "flex flex-col gap-4",
        props.centered ? "items-center text-center" : "items-start",
      )}
    >
      <Show when={props.icon}>
        {(icon) => icon()}
      </Show>
      <Show when={!props.icon && failure()}>
        <IconWarningCircle aria-hidden="true" class="size-6 text-destructive-text" />
      </Show>
      <Type as={props.headingLevel ?? "h2"} variant="h3">{props.title}</Type>
      <Show when={props.description}>
        {(description) => <Type class="text-muted-foreground">{description()}</Type>}
      </Show>
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
    </div>
  );
}
