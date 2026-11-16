# App-owned Storybook catalog

This app owns its catalog, configuration and audits. Stories import the same production components that the app imports; the app does not depend on story files. Fixtures supply presentation state and simulated boundary responses without replacing component markup.

## Current source and proposed organization

At main `da6cdf3f90f27cebb3d30783d4ced3df853dac64`, eight story files contain 69 named story exports: Study 25, Karaoke 18, Dance 24 and optional community naming 2. These are source counts, not a rendered index or parity result. This source proposal adds three files and 13 named stories for the community shell, playback controls and wallet portfolio. Its prospective total is 11 files and 82 named story exports; the next real build must establish the actual index.

The sidebar ordering is Screens, Flows and Checkpoint, with feature ordering inside each group. Existing titles, export names and story IDs are unchanged. See [coverage and remaining work](./coverage-map.md).

## Existing tooling

Main already includes `storybook`, `build-storybook`, import-audit and browser-audit scripts in `apps/web/package.json`. Storybook, its Solid/Vite framework and addon-a11y are pinned at 10.6.0. The app uses Solid 2 RC.21 and its independently owned c7-derived Solid2 UI package. The earlier statement that package scripts and the genuine addon lock were missing described an old source handback and is no longer current.

From `apps/web`, the existing source checks/build commands are:

```sh
npm run test:storybook:imports
npm run check:storybook:imports
npm run build-storybook
```

The existing development script is `npm run storybook` on port 6176. Start it only under an allocated runtime slot with an explicit loopback binding. This proposal runs none of these commands, installs nothing and establishes no current preview URL.

The configuration keeps the app's production styles, aliases, deduplication, static assets and document decorator. This proposal changes only sidebar ordering in the preview configuration. It does not change components, app routes, styles, tooling versions, manifests, locks, audits or workflows.

## Evidence and limitations

The import checker traverses imports from actual client/live entrypoints and follows explicitly admitted fixture helpers. It rejects unreachable substitutes and production imports of story/test support. Static reachability does not establish a mounted export, rendered parity or complete user-flow coverage.

The actual served index determines story IDs and count. The browser audit retains per-story render/play/page failures, viewport evidence, screenshot digests, accessibility violations and incomplete checks. Its existing exact-source/browser binding and process supervisor remain unchanged. Run it later with the documented CLI inputs and fresh outputs under runtime custody; do not reuse a historical run as acceptance for these source changes.

Historical November 12/13 builds, failures, screenshots and later narrow qualification remain dated evidence at their own source/tool pins. They are not current-main or Solid2 acceptance. All 13 new stories, their six play functions, the ordering change and the revised prospective catalog are UNRUN. No screenshot, accessibility, Paper or full-flow parity is claimed by source authoring.

Wallet and media reference text files remain provenance, not executable stories. Primitive/pattern stories from the UI package are not automatically part of this app catalog. Add coverage through real imported production components and explicit fixtures, rather than copying a second implementation into stories.

## Coordination

Catalog documentation and story-only authoring proceed independently of the installed journey and MOSS work. Component defects go to their owning writers as separate proposals. Paper changes require an accepted design decision. Live exploration remains independent.

No release gate is added by this organization pass. Existing repository, browser, reproducibility, CI and release checks remain in force. Main currently has no Storybook workflow job; rollout of one remains a separate integration decision. A future preview needs one serialized catalog build and, only if requested for review, a temporary loopback server. Keep installed-journey qualification higher priority.
