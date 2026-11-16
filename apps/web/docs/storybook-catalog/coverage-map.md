# Catalog coverage and next work

Baseline: main `da6cdf3f90f27cebb3d30783d4ced3df853dac64`. Counts are named source exports, not built-index entries. Existing stories are preserved byte-for-byte by this proposal.

| Area | Main files / exports | Proposal | What remains |
| --- | --- | --- | --- |
| Study | 2 / 25 | Unchanged | Current-source render/play/a11y results and actual account/SDK flow acceptance |
| Karaoke | 2 / 18 | Unchanged | Current-source recording, playback and recovery qualification |
| Dance | 3 / 24 | Unchanged | Current production/service/private-state and rendered qualification; engineering extensions are not exact Paper frames |
| Optional community naming | 1 / 2 | Unchanged | Real membership/authentication and eligible naming |
| Community shell | 0 / 0 | 1 file / 4 stories | Route navigation and full app composition |
| Playback controls | 0 / 0 | 1 file / 4 stories | Real media delivery, timing, seeking and persistence |
| Wallet portfolio | 0 / 0 | 1 file / 5 stories | MOSS/account lifecycle, balance transport, quotes, sponsored sending and effects |
| Posting / video | 0 / 0 | No change | Executable stories for production composer, capture, processing, holds and completion |
| Profile / settings | 0 / 0 | No change | Real mounted page/component stories |
| UI primitives / patterns | No app catalog files | No change | Deliberate reusable-component coverage using the production UI package |

The main baseline is 8 files / 69 exports. The proposal adds 3 files / 13 exports, yielding a prospective 11 / 82. Existing reference snapshots are excluded.

## New wrapper ownership and source joins

| New story file | Imported production component | Confirmed application use | Prepared states |
| --- | --- | --- | --- |
| `src/shell/community-app-shell.stories.tsx` | `src/live/app-shell.tsx` CommunityAppShell | `src/live/entry.tsx` | Anonymous, SignedIn, ResolvingSession, Busy |
| `src/shell/player/song-playback-controls.stories.tsx` | `src/shell/player/playback-controls.tsx` SongPlaybackControls | `src/shell/reference/song-player.tsx` | Paused, Playing, Buffering, SeekingUnavailable |
| `src/wallet/wallet-portfolio.stories.tsx` | `src/wallet/established/wallet-portfolio.tsx` WalletPortfolio | `src/live/rewards.tsx` | Ready, Loading, BalancesUnavailable, Empty, Receive |

These wrappers import production markup. They do not call native devices, SDKs, backend transports or signing/provider operations. The shell's navigation links remain actual app destinations; no play clicks them. Playback changes local presentation signals without audio. Wallet uses a public dummy address, fixture balances and the existing receive sheet, with no send/claim implementation or real wallet connection.

Six prepared play functions cover play/pause transitions, the disabled buffering state, disabled refresh while loading, the empty-wallet message and opening the real portalled receive sheet. All are UNRUN. They do not establish media playback or wallet/authentication acceptance.

## Bounded next steps

1. Review/apply only docs, preview ordering and the three new story files. Preserve current story IDs and all historical evidence.
2. When a runtime slot is available, run the existing production-import check and one unfiltered catalog build against the selected source/toolchain. Record actual counts and any failures.
3. Review the resulting preview before expanding stories. Queue interaction/a11y/screenshots separately, retaining every failure/incomplete.
4. Add profile/settings and posting/video stories through their actual production components. Return product repairs to their writers without weakening checks or changing components in this lane.

Sidebar organization is an explicit sort order only. Existing Screens/Studying, Screens/Karaoke, Flows/Studying, Flows/Karaoke, Flows/Dance and Checkpoint/Community titles and export names are preserved. New groups are Screens/Shell, Screens/Wallet and Flows/Shell. This proposal does not rename existing IDs or restructure production routes.

The catalog is parallel frontend work. It creates no new dependency for the installed journey, MOSS qualification or release. Paper/manual design acceptance, real provider/device effects and hosted CI remain separate.
