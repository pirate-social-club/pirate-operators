import { Show } from "solid-js";
import {
  videoPlaybackMessage,
  videoThumbnailMessage,
  type VideoDeliveryState,
} from "./delivery-state.ts";

/**
 * The author-visible delivery state for a video that cannot play yet. One
 * playback line, and the thumbnail line only where it adds information; feed
 * cards do not render this at all, so processing never becomes a wall of text.
 */
export function VideoDeliveryPending(props: {
  readonly state: VideoDeliveryState;
  readonly showThumbnailMessage?: boolean;
}) {
  return (
    <section
      class="grid gap-1 rounded-2xl border border-border-soft p-5"
      role="status"
      data-video-playback-state={props.state.playback}
      data-video-thumbnail-state={props.state.thumbnail}
    >
      <p>{videoPlaybackMessage(props.state)}</p>
      <Show
        when={
          props.showThumbnailMessage === true &&
          props.state.thumbnail !== "ready"
        }
      >
        <p class="text-sm text-muted-foreground">
          {videoThumbnailMessage(props.state)}
        </p>
      </Show>
    </section>
  );
}
