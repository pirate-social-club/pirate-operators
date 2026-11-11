// Independently owned presentation from src/features/community/page-shell/community-more-menu.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
/** @jsxImportSource @solidjs/web */
import { createEffect, createSignal, For } from "solid-js";
import {
  createMediaQuery,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconDotsThree,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  toast,
} from "../design-system.ts";

/** Management authority as the banner reports it, read without opening the menu. */
export type CommunityManageAuthority = "available" | "pending" | "unavailable";

export interface CommunityMoreAction {
  readonly id: "share" | "unfollow" | "manage";
  readonly label: string;
  readonly run: () => void;
}

/** What Share needs from the browser; `navigator` provides it where it exists. */
export interface ShareCapabilities {
  readonly share?: (data: ShareData) => Promise<void>;
  readonly clipboard?: { readonly writeText: (text: string) => Promise<void> };
}

/**
 * Shares the community's address: the platform share sheet where the browser
 * has one, otherwise the clipboard with a confirmation. A share the viewer
 * dismisses is not an error and says nothing.
 */
export async function shareCommunityLink(
  url: string,
  title: string,
  nav: ShareCapabilities = globalThis.navigator,
): Promise<"shared" | "copied" | "dismissed" | "failed"> {
  if (nav.share !== undefined) {
    try {
      await nav.share({ title, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return "dismissed";
      // A refused share (no user activation, unsupported data) still has the clipboard.
    }
  }
  try {
    if (nav.clipboard === undefined) throw new Error("clipboard unavailable");
    await nav.clipboard.writeText(url);
    toast.success("Link copied");
    return "copied";
  } catch {
    toast.error("The link could not be copied.");
    return "failed";
  }
}

const triggerClass =
  "grid size-10 shrink-0 place-items-center rounded-full bg-background/75 text-foreground backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The banner's More control: a dropdown on desktop and a bottom sheet on a
 * phone, holding the same rows. It is always present; what it holds depends
 * on the viewer. The triggers report management authority so a surface can
 * read it without opening an overlay.
 */
export function CommunityMoreMenu(props: {
  actions: readonly CommunityMoreAction[];
  manage: CommunityManageAuthority;
}) {
  const [sheetOpen, setSheetOpen] = createSignal(false, { ownedWrite: true });
  const [menuOpen, setMenuOpen] = createSignal(false, { ownedWrite: true });
  const desktop = createMediaQuery("(min-width: 768px)");
  createEffect(desktop, (wide, previous) => {
    if (previous !== undefined && wide !== previous) {
      setMenuOpen(false);
      setSheetOpen(false);
    }
  });
  const manageAttribute = () =>
    props.manage === "unavailable" ? undefined : props.manage;
  return (
    <div class="shrink-0">
      <div class="hidden md:block">
        <DropdownMenu
          open={menuOpen()}
          onOpenChange={setMenuOpen}
          placement="bottom-end"
          gutter={4}
        >
          <DropdownMenuTrigger
            aria-label="More community options"
            class={triggerClass}
            data-community-manage={manageAttribute()}
            data-community-more="menu"
          >
            <IconDotsThree class="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            aria-label="More community options"
            class="w-[208px] rounded-[var(--radius-lg)] p-1 shadow-none outline-none"
            data-community-more-content="menu"
          >
            <For each={props.actions}>
              {(action) => (
                <DropdownMenuItem
                  class="h-10 rounded-[var(--radius-md)] px-3 py-0 text-base leading-6"
                  data-community-more-action={action.id}
                  onSelect={() => action.run()}
                >
                  {action.label}
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div class="md:hidden">
        <Sheet open={sheetOpen()} onOpenChange={setSheetOpen}>
          <SheetTrigger
            aria-label="More community options"
            class={triggerClass}
            data-community-manage={manageAttribute()}
            data-community-more="sheet"
          >
            <IconDotsThree class="size-5" />
          </SheetTrigger>
          {/* The sheet keeps its visible close (ruling 2026-10-16). Its header
              is the close control's height, so the first row starts below it. */}
          <SheetContent
            side="bottom"
            class="flex flex-col gap-0 rounded-t-[var(--radius-sheet)] bg-background px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-3 shadow-none"
            data-community-more-content="sheet"
          >
            <div
              class="flex h-11 shrink-0 justify-center"
              data-community-more-header
            >
              <div
                aria-hidden="true"
                class="h-1.5 w-12 rounded-full bg-border"
              />
            </div>
            <SheetTitle class="sr-only">More community options</SheetTitle>
            <div
              role="group"
              aria-label="More community options"
              class="flex flex-col"
            >
              <For each={props.actions}>
                {(action, index) => (
                  <button
                    type="button"
                    class={`flex shrink-0 items-center text-start text-base leading-6 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${index() === 0 ? "h-14 pt-2" : "h-12 border-t border-border-soft"}`}
                    data-community-more-action={action.id}
                    onClick={() => {
                      setSheetOpen(false);
                      action.run();
                    }}
                  >
                    {action.label}
                  </button>
                )}
              </For>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
