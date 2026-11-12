/** Browser UI port. Public community audio has no fabricated bearer lifetime. */
export interface SongPlaybackGrant {
  readonly playback_url: string;
  readonly expires_at?: number;
  readonly renew_after?: number;
}

export function publicPlaybackAccess(audioUrl: string): SongPlaybackGrant {
  const url = new URL(audioUrl, location.origin);
  if (url.origin !== location.origin || url.username || url.password)
    throw new Error(
      "Playback must use this community's published audio endpoint.",
    );
  return { playback_url: url.href };
}
