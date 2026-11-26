import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Button, cn } from "../design-system.ts";

export interface ActivityFooterProps {
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryIcon?: JSX.Element;
  primaryLabel?: string;
  primaryVariant?: "default" | "destructive" | "secondary";
  secondaryIcon?: JSX.Element;
  secondaryLabel?: string;
  /** Results: "again" and Continue side by side, Continue on the right. */
  results?: boolean;
}

/** Shared mobile-safe action footer for Study, Karaoke and route status states. */
export function ActivityFooter(props: ActivityFooterProps) {
  return (
    <Show when={props.primaryLabel}>
      <footer class="sticky bottom-0 z-10 mx-auto w-full max-w-[640px] border-t border-border-soft bg-background/95 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 backdrop-blur-xl">
        <div class={cn("mx-auto grid w-full max-w-[640px] gap-3", props.secondaryLabel && (props.results ? "grid-cols-2" : "sm:grid-cols-2"))}>
          <Show when={props.results && props.secondaryLabel}>
            <Button class="h-13 w-full" leadingIcon={props.secondaryIcon} onClick={props.onSecondaryAction} size="lg" variant="secondary">
              {props.secondaryLabel}
            </Button>
          </Show>
          <Button
            class="h-13 w-full"
            disabled={props.primaryDisabled}
            leadingIcon={props.primaryIcon}
            loading={props.primaryLoading}
            onClick={props.onPrimaryAction}
            size="lg"
            variant={props.primaryVariant ?? "default"}
          >
            {props.primaryLabel}
          </Button>
          <Show when={!props.results && props.secondaryLabel}>
            <Button
              class="h-13 w-full"
              leadingIcon={props.secondaryIcon}
              onClick={props.onSecondaryAction}
              size="lg"
              variant="secondary"
            >
              {props.secondaryLabel}
            </Button>
          </Show>
        </div>
      </footer>
    </Show>
  );
}
