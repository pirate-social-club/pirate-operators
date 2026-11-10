import { createSignal, For, Show } from "solid-js";
import { Button } from "../ui.ts";
import type { CommunityFeed } from "../api-contract.ts";
import type { RewardAvailableOffers } from "../../../../packages/rewards/contracts.ts";

export function SongFeed(props: {
  feed: CommunityFeed;
  signedIn: boolean;
  study: boolean;
  rewards: boolean;
  offers: RewardAvailableOffers | null;
  onStudy: (song: { postId: string; title: string }) => void;
  onSing: (song: { postId: string; title: string }) => void;
}) {
  return (
    <Show
      when={props.feed.posts.length > 0}
      fallback={
        <div class="live-empty">
          <span aria-hidden="true">♪</span>
          <h3>The first release starts here.</h3>
          <p>Published songs will appear in this community feed.</p>
        </div>
      }
    >
      <For each={props.feed.posts}>
        {(song) => {
          const [playbackError, setPlaybackError] = createSignal(false);
          let player: HTMLAudioElement | undefined;
          return (
            <article class="live-song" id={`song-${song.manifest.postId}`}>
              <div class="app-song-heading">
                <span class="app-song-art" aria-hidden="true">
                  ♪
                </span>
                <div>
                  <p class="live-kicker">
                    {song.manifest.rating === "adult" ? "EXPLICIT" : "SONG"}
                  </p>
                  <h3>
                    <a href={`/#song-${song.manifest.postId}`}>
                      {song.manifest.title}
                    </a>
                  </h3>
                  <p class="live-muted">
                    Creator {song.manifest.authorId.slice(2, 10)}
                  </p>
                </div>
              </div>
              <Show
                when={song.manifest.declarationSource === "operator_declared"}
              >
                <p class="live-muted">
                  Rating and language declared by the operator. Automated
                  content moderation is deferred.
                </p>
              </Show>
              <audio
                ref={(node) => {
                  player = node;
                }}
                aria-label={`Play ${song.manifest.title}`}
                controls
                preload="metadata"
                src={song.audioUrl}
                onError={() => setPlaybackError(true)}
                onLoadedMetadata={() => setPlaybackError(false)}
                onPlay={(event) => {
                  // Only one feed recording plays at a time, including public videos.
                  for (const media of document.querySelectorAll<HTMLMediaElement>(
                    "audio, video",
                  ))
                    if (media !== event.currentTarget) media.pause();
                }}
              />
              <Show when={playbackError()}>
                <p role="status">
                  This recording could not be played. Check your connection and
                  retry.
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPlaybackError(false);
                    player?.load();
                    void player?.play().catch(() => setPlaybackError(true));
                  }}
                >
                  Retry playback
                </Button>
              </Show>
              <Show when={props.signedIn && props.rewards}>
                <Show
                  when={props.offers}
                  fallback={
                    <p class="live-muted">Reward details are unavailable.</p>
                  }
                >
                  {(available) => (
                    <For
                      each={available().offers.filter(
                        (offer) => offer.postId === song.manifest.postId,
                      )}
                    >
                      {(offer) => (
                        <details>
                          <summary>
                            Lottery reward · {offer.ticketCount}{" "}
                            {offer.ticketCount === 1 ? "ticket" : "tickets"}
                          </summary>
                          <p>
                            Practice rewards have no cash value in this pilot.
                            Complete Study with at least 70% correct on the
                            first try, or Karaoke with a score of at least 70%
                            and at least 90% of lines measured. One entry per
                            account.
                          </p>
                          <p>
                            Complete and publish your result between{" "}
                            {new Date(offer.opensAt).toLocaleString()} and{" "}
                            {new Date(offer.cutoffAt).toLocaleString()}.
                            Winnings are shared equally among qualifying
                            accounts. There may be no prize. Any remainder stays
                            with the operator.
                          </p>
                          <p>
                            Winning shares appear in your wallet. Scan your palm
                            to claim; payments are approved daily. Unclaimed
                            shares stay available. If nobody qualifies, winnings
                            stay with the operator.
                          </p>
                        </details>
                      )}
                    </For>
                  )}
                </Show>
              </Show>
              <Show
                when={props.signedIn}
                fallback={
                  <p class="live-muted">
                    Sign in with MOSS to study or sing this song.
                  </p>
                }
              >
                <div class="app-song-actions">
                  <Show when={props.study}>
                    <Button
                      variant="outline"
                      onClick={() =>
                        props.onStudy({
                          postId: song.manifest.postId,
                          title: song.manifest.title,
                        })
                      }
                    >
                      Study
                    </Button>
                  </Show>
                  <Button
                    variant="outline"
                    onClick={() =>
                      props.onSing({
                        postId: song.manifest.postId,
                        title: song.manifest.title,
                      })
                    }
                  >
                    Sing
                  </Button>
                </div>
              </Show>
              <Show when={song.lyricsText}>
                <details>
                  <summary>Lyrics</summary>
                  <p class="live-lyrics">{song.lyricsText}</p>
                </details>
              </Show>
              <a
                class="live-receipt"
                href={`/api/public/posts/${song.manifest.postId}/proof`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Publication receipt ↗
              </a>
            </article>
          );
        }}
      </For>
    </Show>
  );
}
