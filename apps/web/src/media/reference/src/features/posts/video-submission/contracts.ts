export class VideoContractError extends Error {}
export interface SongVideoSelection {
  readonly songPostId: string;
  readonly audioRevision: number;
  readonly clipStartSamples: number;
  readonly clipDurationSamples: number;
  readonly selectedFrom:
    | Readonly<{ kind: "library" }>
    | Readonly<{ kind: "feed"; postId: string }>;
}
