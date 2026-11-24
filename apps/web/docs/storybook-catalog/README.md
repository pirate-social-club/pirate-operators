# App-owned Storybook catalog

This app owns its catalog, configuration and audits. Stories import the same production components the app imports; the app never depends on story files. Fixtures supply presentation state and simulated boundary responses without replacing component markup, and screen stories render the real route with data mocked at the data boundary so the catalog stays perfectly representative of production.

## Sidebar: feature-first

The sidebar groups by feature, because that is how a reviewer reaches for it: one place per feature, no duplicates. Under each feature the tiers order themselves:

    Studying / Screens / Route
    Studying / Flows  / Session

The design system's shared tiers follow the features, since those are not tied to one feature:

    Foundations / Components / Patterns

## Tiers live in tags, enforced by script

The sidebar position carries no discipline; the metadata does. Every story file declares exactly one tier tag, and `npm run check:ui:stories` fails the build on violations:

- `screen`: a route-level view or a shell a router renders. A screen owns the page structure, so it must not disable the two page-level axe rules; if it needs them off, it is a fragment and belongs to flow or part.
- `flow`: a multi-step journey. A flow-tagged file must carry at least one interactive play through the happy path plus a failure state.
- `part`: a feature-scoped component below screen level.

Pick the tier by asking what the story is, then name the feature, then the component: `Parts/Bookings/SlotPicker` becomes `Bookings/Parts/SlotPicker` in the sidebar. Keep `a11y: { test: "error" }`; violations are failures, not opt-outs.

## Review modes

The toolbars review everything the lock requires: theme (dark, light, system), direction (auto, LTR, RTL) and locale (English, Arabic, Chinese, pseudo). A component is not locked until every state has a story reviewed in both themes and both directions. The vendored package's Foundations pages document the token sheet: colors, typography, spacing and sizing, radius and elevation, icons and motion.

## Existing tooling

From `apps/web`:

```sh
npm run storybook                # dev catalog on port 6176
npm run build-storybook          # static build
npm run check:storybook:imports  # production reachability audit
npm run check:ui:tokens          # raw-hex conformance over app source
npm run check:ui:stories         # tier-tag conformance over app stories
npm run audit:storybook          # exact-source-bound browser audit
```

The import checker traverses imports from actual client/live entrypoints and follows explicitly admitted fixture helpers; it rejects unreachable substitutes. The token checker fails on raw hex outside the named exemptions recorded in its script. Static reachability does not establish a mounted export or rendered parity; the browser audit and the behavior contract suite carry that load.
