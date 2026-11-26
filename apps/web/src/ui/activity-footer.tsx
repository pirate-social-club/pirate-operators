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
  onPrimaryFocus?: () => void;
  onPrimaryPointerDown?: () => void;
  onPrimaryPointerEnter?: () => void;
  primaryVariant?: "default" | "destructive" | "secondary";
  secondaryIcon?: JSX.Element;
  secondaryLabel?: string;
  secondaryDisabled?: boolean;
  secondaryLoading?: boolean;
  /** Custom status or alert content above the action row. */
  topSlot?: JSX.Element;
  notice?: JSX.Element;
  error?: JSX.Element;
  /** Results: "again" and Continue side by side, Continue on the right. */
  results?: boolean;
}

/** Shared mobile-safe action footer for Study, Karaoke and route status states. */
export function ActivityFooter(props: ActivityFooterProps) {
  return (
    <Show when={props.primaryLabel}>
      <footer class="sticky bottom-0 z-10 mx-auto w-full max-w-[640px] border-t border-border-soft bg-background/95 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 backdrop-blur-xl">
        <Show when={props.topSlot}>
          {(slot) => <div class="mb-3">{slot()}</div>}
        </Show>
        <Show when={props.error}>
          {(error) => <p role="alert" class="mb-3 text-center text-sm text-destructive-text">{error()}</p>}
        </Show>
        <Show when={props.notice}>
          {(notice) => <p role="status" class="mb-3 text-center text-sm text-muted-foreground">{notice()}</p>}
        </Show>
        <div class={cn("mx-auto grid w-full max-w-[640px] gap-3", props.secondaryLabel && (props.results ? "grid-cols-2" : "sm:grid-cols-2"))}>
          <Show when={props.results && props.secondaryLabel}>
            <Button class="h-13 w-full" disabled={props.secondaryDisabled} leadingIcon={props.secondaryIcon} loading={props.secondaryLoading} onClick={props.onSecondaryAction} size="lg" variant="secondary">
              {props.secondaryLabel}
            </Button>
          </Show>
          <Button
            class="h-13 w-full"
            disabled={props.primaryDisabled}
            leadingIcon={props.primaryIcon}
            loading={props.primaryLoading}
            onClick={props.onPrimaryAction}
            onFocus={props.onPrimaryFocus}
            onPointerDown={props.onPrimaryPointerDown}
            onPointerEnter={props.onPrimaryPointerEnter}
            size="lg"
            variant={props.primaryVariant ?? "default"}
          >
            {props.primaryLabel}
          </Button>
          <Show when={!props.results && props.secondaryLabel}>
            <Button
              class="h-13 w-full"
              disabled={props.secondaryDisabled}
              leadingIcon={props.secondaryIcon}
              loading={props.secondaryLoading}
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
