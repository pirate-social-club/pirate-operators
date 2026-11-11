// Independently owned source copy. src/features/posts/shared-engagement/content-overflow-menu.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Adapter differences: docs/v1-shell-owner-correction-20261111.md.
import { For, Show } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconDotsThree,
} from "../design-system.ts";

export interface ContentAction {
  readonly label: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/**
 * Controllers supply permitted actions; no handler means no menu.
 *
 * `inline` draws the 32px mark of a card's author row while keeping a 44px
 * touch target. The negative margins let the target overhang the row, so the
 * row keeps its text height instead of growing to the target's.
 */
export function ContentOverflowMenu(props: {
  label: string;
  actions?: readonly ContentAction[];
  inline?: boolean;
}) {
  return (
    <Show when={props.actions?.length}>
      <DropdownMenu modal={false} placement="bottom-end">
        <Show
          when={props.inline}
          fallback={
            <DropdownMenuTrigger
              aria-label={props.label}
              class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <IconDotsThree class="size-6" aria-hidden="true" />
            </DropdownMenuTrigger>
          }
        >
          <DropdownMenuTrigger
            aria-label={props.label}
            class="group -my-2.5 -me-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span class="grid size-8 place-items-center rounded-full group-hover:bg-muted">
              <IconDotsThree class="size-5" aria-hidden="true" />
            </span>
          </DropdownMenuTrigger>
        </Show>
        <DropdownMenuContent>
          <For each={props.actions}>
            {(action) => (
              <DropdownMenuItem
                as="button"
                disabled={action.disabled}
                onSelect={() => {
                  if (!action.disabled) action.run();
                }}
              >
                {action.label}
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  );
}
