// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-lyric-stage.tsx; only imports changed.
import { For, Show } from "solid-js";
import { Type } from "../ui.ts";
import type { KaraokeStageLine, KaraokeStageToken } from "../../../../packages/karaoke/lyric-transform.ts";
import { displayLines } from "../../../../packages/karaoke/karaoke-timing.ts";
import "./karaoke.css";

export type { KaraokeStageLine, KaraokeStageToken } from "../../../../packages/karaoke/lyric-transform.ts";

export type KaraokeRatingTone = "success" | "info" | "warning" | "destructive";

export interface KaraokeLineRating {
  lineId: string;
  key: string;
  label: string;
  points: number;
  tone: KaraokeRatingTone;
}

export interface KaraokeLyricStageProps {
  lines: readonly KaraokeStageLine[];
  currentTimeMs: number;
  rating?: KaraokeLineRating | null;
  /** Keeps feedback visible in deterministic story renders; live feedback remains transient by default. */
  ratingPersistent?: boolean;
  primed?: boolean;
}

function tokenProgress(token: KaraokeStageToken, currentTimeMs: number) {
  if (token.endMs <= token.startMs) return currentTimeMs >= token.endMs ? 1 : 0;
  return Math.min(1, Math.max(0, (currentTimeMs - token.startMs) / (token.endMs - token.startMs)));
}

function Line(props: { line: KaraokeStageLine; mode: "active" | "cue" | "next"; currentTimeMs: number }) {
  return (
    <Type as="p" aria-label={props.line.text} class={`karaoke-line karaoke-line-${props.mode}`} dir="auto" variant={props.mode === "next" ? "h2" : "h1"}>
      <For each={props.line.tokens}>
        {(token, index) => {
          const active = () => props.mode === "active" && props.currentTimeMs >= token.startMs && props.currentTimeMs < token.endMs;
          const complete = () => props.mode === "active" && props.currentTimeMs >= token.endMs;
          const trailing = () => token.trailing ?? (index() < props.line.tokens.length - 1 ? " " : "");
          return (
            <span class="karaoke-token" data-token-state={complete() ? "complete" : active() ? "active" : "upcoming"}>
              <span>{token.text}</span>
              <Show when={active()}>
                <span aria-hidden="true" class="karaoke-token-fill" style={{ width: `${tokenProgress(token, props.currentTimeMs) * 100}%` }}>{token.text}</span>
              </Show>
              <Show when={trailing()}>
                <span aria-hidden="true">{trailing()}</span>
              </Show>
            </span>
          );
        }}
      </For>
    </Type>
  );
}

export function KaraokeLyricStage(props: KaraokeLyricStageProps) {
  const visible = () => displayLines(props.lines, props.currentTimeMs);
  return (
    <div aria-live="off" class="karaoke-stage">
      <Show keyed when={props.rating?.key}>
        {(ratingKey) => (
          <div data-rating-key={ratingKey} class={`karaoke-stage-rating${props.ratingPersistent ? " karaoke-stage-rating-static" : ""}`} data-rating-tone={props.rating?.tone}>
            <span class="karaoke-stage-rating-label">{props.rating?.label}</span>
            <span class="karaoke-stage-rating-points">+{props.rating?.points}</span>
          </div>
        )}
      </Show>
      <div class="karaoke-stage-lines">
        <Show when={visible().activeLine}>
          {(line) => <Line currentTimeMs={props.currentTimeMs} line={line()} mode="active" />}
        </Show>
        <Show when={visible().cueLine}>
          {(line) => <Line currentTimeMs={props.currentTimeMs} line={line()} mode={props.primed ? "active" : "cue"} />}
        </Show>
        <Show when={visible().nextLine}>
          {(line) => <Line currentTimeMs={props.currentTimeMs} line={line()} mode="next" />}
        </Show>
      </div>
    </div>
  );
}
