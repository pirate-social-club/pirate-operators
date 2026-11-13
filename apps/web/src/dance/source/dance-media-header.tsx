import { IconArrowLeft, IconMusicNote, IconX } from "../design-system.ts";

/** Paper phone view/review header:56px,44px back,36px song pill.
 * The label comes from the frozen selected catalogue item, never an account
 * or wallet surrogate. A captured excerpt is not an editable song control. */
export function DanceMediaHeader(props: { readonly songLabel?: string; readonly onBack: () => void }) {
  return <header class="absolute inset-x-4 top-2 z-20 flex h-14 items-center justify-between text-white">
    <button type="button" aria-label="Back to dance" class="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-white" onClick={props.onBack}>
      <IconArrowLeft class="size-[22px]" />
    </button>
    <div class="flex h-9 min-w-0 items-center gap-2 rounded-full bg-black/55 px-3.5 text-sm font-semibold leading-5">
      <IconMusicNote aria-hidden="true" class="size-4 shrink-0" />
      <span class="truncate">{props.songLabel || "Dance"}</span>
    </div>
    <span aria-hidden="true" class="size-11 shrink-0" />
  </header>;
}

export function DanceStatusHeader(props: { readonly onBack: () => void }) {
  return <header class="relative z-20 flex h-14 shrink-0 items-center justify-between px-4">
    <button type="button" aria-label="Back to dance" class="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-current" onClick={props.onBack}><IconX class="size-5" /></button>
    <span class="flex-1 text-center text-lg font-semibold leading-7">Dance</span>
    <span aria-hidden="true" class="size-11 shrink-0" />
  </header>;
}
