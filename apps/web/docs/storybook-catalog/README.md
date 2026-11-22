# App-owned Storybook catalog

This app owns its catalog, configuration and audits. Stories import the same production components the app imports; the app never depends on story files. Fixtures supply presentation state and simulated boundary responses without replacing component markup, and screen stories render the real route with data mocked at the data boundary so the catalog stays perfectly representative of production.

## Tiers

The top segment says what a story *is*; the feature is always the second segment. Tier order in the sidebar:

Flows / Screens / Parts / Foundations / Components / Patterns

`Flows` is a multi-step journey a person moves through, with one story per step or outcome; each flow file carries at least one interactive play through the happy path plus a failure state. `Screens` is a route-level view or a shell that hosts one; if a router would render it directly, it is a screen. `Parts` is everything below screen level that belongs to a feature rather than the design system. `Foundations`, `Components` and `Patterns` belong to the vendored `@pirate/web-solid-ui` package and are composed into this catalog so a token can be reviewed on its Foundations page and in the screens that use it without switching runners.

When adding a story, pick the tier by asking what the story is, then name the feature, then the component: `Parts/Bookings/SlotPicker`. Keep `a11y: { test: "error" }`; violations are failures, not opt-outs. Page-level axe rules are disabled only on fragment-tier stories whose production mount supplies the page structure, with the tier rationale recorded in the story meta.

## Review modes

The catalog's toolbars review everything the lock requires: theme (dark, light, system), direction (auto, LTR, RTL) and locale (English, Arabic, Chinese, pseudo). A component is not locked until every state has a story that has been reviewed in both themes and both directions. The vendored package's Foundations pages document the token sheet: colors, typography, spacing and sizing, radius and elevation, icons and motion.

## Existing tooling

From `apps/web`:

```sh
npm run storybook            # dev catalog on port 6176
npm run build-storybook      # static build
npm run check:storybook:imports   # production reachability audit
npm run check:ui:tokens      # raw-hex conformance over app source
npm run audit:storybook      # exact-source-bound browser audit
```

The import checker traverses imports from actual client/live entrypoints and follows explicitly admitted fixture helpers; it rejects unreachable substitutes. The token checker fails on raw hex outside the named exemptions recorded in `scripts/ui/token-conformance.mjs`. Static reachability does not establish a mounted export or rendered parity; the browser audit and the behavior contract suite carry that load.
