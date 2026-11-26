import { Dynamic, type JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { cn } from "@/lib/cn";

export interface LearningActivityFrameProps {
  as?: "div" | "main" | "section";
  ariaBusy?: boolean;
  ariaLabel?: string;
  ariaAtomic?: boolean;
  ariaLive?: "assertive" | "off" | "polite";
  background?: JSX.Element;
  children?: JSX.Element;
  class?: string;
  contentClass?: string;
  /** Names the content region when a state needs an explicit landmark. */
  contentLabel?: string;
  footer?: JSX.Element;
  header?: JSX.Element;
}

/** One Learning-owned viewport frame for Study and Karaoke activity states. */
export function LearningActivityFrame(props: LearningActivityFrameProps) {
  return (
    <Dynamic
      component={props.as ?? "div"}
      aria-busy={props.ariaBusy ? "true" : undefined}
      aria-label={props.ariaLabel}
      aria-atomic={props.ariaAtomic ? "true" : undefined}
      aria-live={props.ariaLive}
      class={cn("flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground", props.class)}
    >
      <Show when={props.header}>
        <div class="mx-auto w-full max-w-[640px] shrink-0" data-activity-frame-slot="header">
          {props.header}
        </div>
      </Show>
      <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show when={props.background}>
          <div class="absolute inset-0">{props.background}</div>
        </Show>
        <div
          aria-label={props.contentLabel}
          class={cn(
            "relative z-10 mx-auto flex h-full min-h-0 w-full max-w-[640px] flex-col overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            props.contentClass,
          )}
          data-activity-frame-slot="content"
          role={props.contentLabel ? "region" : undefined}
          tabindex="0"
        >
          {props.children}
        </div>
      </div>
      <Show when={props.footer}>
        <div class="mx-auto w-full max-w-[640px] shrink-0" data-activity-frame-slot="footer">
          {props.footer}
        </div>
      </Show>
    </Dynamic>
  );
}
