# App-owned Storybook catalog

This app owns its catalog, configuration and audits. Stories import the same production components that the app imports; the app does not depend on story files. Fixtures supply presentation state and simulated boundary responses without replacing component markup.

## Current catalog

The baseline at main `da6cdf3f90f27cebb3d30783d4ced3df853dac64` had eight story files and 69 exports. Three added files cover the community shell, playback controls and wallet portfolio with 13 more stories. The actual built index at `5585c218d9bbdabb9d5be59e6dfbafe47912b23b` contains 82 stories across 11 files: Study 25, Karaoke 18, Dance 24, optional naming 2, shell 4, playback controls 4 and wallet portfolio 5.

The sidebar ordering is Screens, Flows and Checkpoint, with feature ordering inside each group. Existing titles, export names and story IDs are unchanged. See [coverage and remaining work](./coverage-map.md).

## Existing tooling

Main already includes `storybook`, `build-storybook`, import-audit and browser-audit scripts in `apps/web/package.json`. Storybook, its Solid/Vite framework and addon-a11y are pinned at 10.6.0. The app uses Solid 2 RC.21 and its independently owned c7-derived Solid2 UI package. The earlier statement that package scripts and the genuine addon lock were missing described an old source handback and is no longer current.

From `apps/web`, the existing source checks/build commands are:

```sh
npm run test:storybook:imports
npm run check:storybook:imports
npm run build-storybook
```

The existing development script is `npm run storybook` on port 6176. Start it only under an allocated runtime slot with an explicit loopback binding. The qualification below used the existing scripts and installed locked dependencies. It establishes no persistent preview URL.

The configuration keeps the app's production styles, aliases, deduplication, static assets and document decorator. The preview configuration changes only sidebar ordering. The catalog also binds the existing Karaoke lyric fixture directly, creates the playback seekability memo in component scope, and corrects the production shell brand/account accessible names. App routes, styles, tooling versions, manifests, locks, audits and workflows are unchanged.

## Evidence and limitations

The import checker traverses imports from actual client/live entrypoints and follows explicitly admitted fixture helpers. It rejects unreachable substitutes and production imports of story/test support. Static reachability does not establish a mounted export, rendered parity or complete user-flow coverage.

The actual served index determines story IDs and count. The browser audit retains per-story render/play/page failures, viewport evidence, screenshot digests, accessibility violations and incomplete checks. Its existing exact-source/browser binding and process supervisor remain unchanged. Use the documented CLI inputs and fresh output directories under runtime custody; do not reuse a historical run as acceptance for changed source.

Historical November 12/13 builds, failures, screenshots and later narrow qualification remain dated evidence at their own source/tool pins. They are not current-main or Solid2 acceptance. At `5585c218`, affected type checking passed in 13.085 seconds and the static build in 22.016 seconds. The existing full browser audit completed all 157 selected viewport observations in 104.296 seconds with zero failures. All 13 new stories and six new play functions ran. Screenshots and per-story results were retained; the owned browser/server closed and the port refused afterward.

The initial full audit failed 30 observations. A first repair reduced that to one account-button accessible-name mismatch; removing its redundant override produced the passing rerun. These failed runs remain historical evidence. No assertions or accessibility rules were suppressed.

The passing automated run still reports 73 incomplete accessibility rule observations, including focus, contrast, captions, prohibited ARIA attributes and label matching. These require manual review; this result is not full accessibility or Paper acceptance. Hosted CI, real provider/device effects and complete user journeys remain separate.

Wallet and media reference text files remain provenance, not executable stories. Primitive/pattern stories from the UI package are not automatically part of this app catalog. Add coverage through real imported production components and explicit fixtures, rather than copying a second implementation into stories.

## Coordination

Catalog documentation and story-only authoring proceed independently of the installed journey and MOSS work. The narrowly reviewed shell accessible-name fixes are included in this catalog change. Further component defects go to their owning writers as separate proposals. Paper changes require an accepted design decision. Live exploration remains independent.

No release gate is added by this organization pass. Existing repository, browser, reproducibility, CI and release checks remain in force. Main currently has no Storybook workflow job; rollout of one remains a separate integration decision. A review preview needs one serialized catalog build and a temporary loopback server. Keep installed-journey qualification higher priority.
