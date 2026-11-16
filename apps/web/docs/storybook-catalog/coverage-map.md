# Catalog coverage and next work

Baseline: main `da6cdf3f90f27cebb3d30783d4ced3df853dac64`. The actual built index at `5585c218d9bbdabb9d5be59e6dfbafe47912b23b` confirms 82 stories. Existing IDs, exports and assertions remain; the Karaoke practice render now binds its existing lyric fixture directly.

| Area | Main files / exports | Proposal | What remains |
| --- | --- | --- | --- |
| Study | 2 / 25 | Unchanged | Manual accessibility review and actual account/SDK flow acceptance |
| Karaoke | 2 / 18 | Existing fixture bound explicitly | Real recording, playback and recovery acceptance |
| Dance | 3 / 24 | Unchanged | Real service/private-state acceptance and manual design review; engineering extensions are not exact Paper frames |
| Optional community naming | 1 / 2 | Unchanged | Real membership/authentication and eligible naming |
| Community shell | 0 / 0 | 1 file / 4 stories | Route navigation and full app composition |
| Playback controls | 0 / 0 | 1 file / 4 stories | Real media delivery, timing, seeking and persistence |
| Wallet portfolio | 0 / 0 | 1 file / 5 stories | MOSS/account lifecycle, balance transport, quotes, sponsored sending and effects |
| Posting / video | 0 / 0 | No change | Executable stories for production composer, capture, processing, holds and completion |
| Profile / settings | 0 / 0 | No change | Real mounted page/component stories |
| UI primitives / patterns | No app catalog files | No change | Deliberate reusable-component coverage using the production UI package |

The main baseline is 8 files / 69 exports. Three added files / 13 exports yield the built 11-file / 82-story catalog. Existing reference snapshots are excluded.

## New wrapper ownership and source joins

| New story file | Imported production component | Confirmed application use | Covered states |
| --- | --- | --- | --- |
| `src/shell/community-app-shell.stories.tsx` | `src/live/app-shell.tsx` CommunityAppShell | `src/live/entry.tsx` | Anonymous, SignedIn, ResolvingSession, Busy |
| `src/shell/player/song-playback-controls.stories.tsx` | `src/shell/player/playback-controls.tsx` SongPlaybackControls | `src/shell/reference/song-player.tsx` | Paused, Playing, Buffering, SeekingUnavailable |
| `src/wallet/wallet-portfolio.stories.tsx` | `src/wallet/established/wallet-portfolio.tsx` WalletPortfolio | `src/live/rewards.tsx` | Ready, Loading, BalancesUnavailable, Empty, Receive |

These wrappers import production markup. They do not call native devices, SDKs, backend transports or signing/provider operations. The shell's navigation links remain actual app destinations; no play clicks them. Playback changes local presentation signals without audio. Wallet uses a public dummy address, fixture balances and the existing receive sheet, with no send/claim implementation or real wallet connection.

Six prepared play functions cover play/pause transitions, the disabled buffering state, disabled refresh while loading, the empty-wallet message and opening the real portalled receive sheet. All ran successfully in the full 157-observation browser audit. They do not establish media playback or wallet/authentication acceptance.

## Qualification and remaining work

The import check, affected type checks and static build passed. The existing full browser audit at `5585c218` recorded every one of 157 viewport observations for 82 stories and passed with zero failures in 104.296 seconds. It retained screenshots and per-story results, then closed its owned browser/server. The first run's 30 failures and the intermediate single failure remain retained; no checks were suppressed.

The final audit has 73 incomplete accessibility rule observations requiring manual review. This is automated catalog qualification, not complete accessibility, Paper parity, actual media capture or real account/provider acceptance. The shell changes include the visible community name in the home button label and let the account button derive its accessible name from displayed content. All existing story exports, IDs and assertions remain.

1. Review incomplete accessibility observations and the rendered catalog before expanding coverage.
2. Add profile/settings and posting/video stories through their actual production components.
3. Qualify real accounts, media and provider effects through their owning user journeys.

Sidebar organization is an explicit sort order only. Existing Screens/Studying, Screens/Karaoke, Flows/Studying, Flows/Karaoke, Flows/Dance and Checkpoint/Community titles and export names are preserved. New groups are Screens/Shell, Screens/Wallet and Flows/Shell. This proposal does not rename existing IDs or restructure production routes.

The catalog is parallel frontend work. It creates no new dependency for the installed journey, MOSS qualification or release. Paper/manual design acceptance, real provider/device effects and hosted CI remain separate.
