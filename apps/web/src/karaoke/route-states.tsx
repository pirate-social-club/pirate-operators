// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; imports only.
import { Button, IconButton, IconCaretLeft, Spinner, Type } from "./ui.ts";

export interface KaraokeRouteLoadingStateProps {
  label?: string;
}

export function KaraokeRouteLoadingState(props: KaraokeRouteLoadingStateProps) {
  return (
    <div aria-busy="true" aria-label={props.label ?? "Loading"} class="grid min-h-dvh w-full place-items-center bg-background text-foreground" role="status">
      <Spinner class="size-6" decorative />
    </div>
  );
}

export interface KaraokeRouteLoadFailureStateProps {
  description: string;
  onGoHome?: () => void;
  onRetry?: () => void;
  title: string;
}

function ErrorGhost() {
  return (
    <div aria-hidden="true" class="grid size-32 place-items-center overflow-hidden rounded-full bg-[#20242c]">
      <img alt="" class="size-24" src="/images/error-ghost.svg" />
    </div>
  );
}

export function KaraokeRouteLoadFailureState(props: KaraokeRouteLoadFailureStateProps) {
  return (
    <main class="flex min-h-dvh items-center justify-center bg-background px-5 text-foreground">
      <div class="flex w-full max-w-[350px] flex-col items-center text-center">
        <ErrorGhost />
        <Type as="h1" class="mt-5 text-xl" variant="h4">{props.title}</Type>
        <Type as="p" class="mt-3 text-muted-foreground" variant="body">{props.description}</Type>
        <div class="mt-5 flex w-full gap-3">
          <Button class="h-13 flex-1" onClick={() => props.onRetry?.()} size="lg">Try Again</Button>
          <Button class="h-13 flex-1" onClick={() => props.onGoHome?.()} size="lg" variant="secondary">Go Home</Button>
        </div>
      </div>
    </main>
  );
}

export interface KaraokeAuthRequiredStateProps {
  artistName?: string;
  artworkSrc?: string;
  ctaLabel?: string;
  description: string;
  leaderboard?: boolean;
  onConnect?: () => void;
  onConnectIntent?: () => void;
  onConnectPreload?: () => void;
  onExit?: () => void;
  songTitle?: string;
  title: string;
}

export function KaraokeAuthRequiredState(props: KaraokeAuthRequiredStateProps) {
  return (
    <main class="min-h-dvh bg-background text-foreground">
      <header class="border-b border-border-soft">
        <div class="flex h-14 items-center gap-3 px-4">
          <IconButton aria-label="Back" class="size-10 bg-secondary" onClick={props.onExit} variant="secondary">
            <IconCaretLeft class="size-5" />
          </IconButton>
          <Type as="h1" variant="h3">{props.leaderboard ? "Leaderboard" : props.title}</Type>
        </div>
        {props.leaderboard && (
          <div class="flex items-center gap-3 px-5 pb-4 pt-2">
            {props.artworkSrc ? <img alt="" aria-hidden="true" class="size-12 shrink-0 rounded-lg object-cover" src={props.artworkSrc} /> : <div aria-hidden="true" class="size-12 shrink-0 rounded-lg bg-secondary" />}
            <div class="min-w-0">
              <Type as="h2" class="truncate" variant="h4">{props.songTitle ?? "Karaoke"}</Type>
              <Type as="p" class="truncate text-muted-foreground" variant="body">{props.artistName ?? "Karaoke scores"}</Type>
            </div>
          </div>
        )}
      </header>
      <div class={props.leaderboard ? "flex flex-col items-center px-5 pt-5 text-center" : "px-5 pt-5"}>
        <Type as="h2" class={props.leaderboard ? "sr-only" : "text-base font-semibold"} variant="body">Sign in</Type>
        <Type as="p" class={props.leaderboard ? "max-w-[300px] text-[15px] leading-5 text-muted-foreground" : "mt-1 max-w-[350px] text-[15px] text-muted-foreground"} variant="body">{props.description}</Type>
        <Button class={props.leaderboard ? "mt-4 h-11 w-[90px]" : "mt-3 h-11 w-[120px]"} loading={false} onClick={() => props.onConnect?.()} onFocus={props.onConnectIntent} onPointerDown={props.onConnectIntent} onPointerEnter={props.onConnectPreload} size="lg">
          {props.ctaLabel ?? "Sign in"}
        </Button>
      </div>
    </main>
  );
}
