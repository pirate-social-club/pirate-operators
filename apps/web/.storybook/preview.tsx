import type { Preview } from "storybook-solidjs-vite";
import { createDecorator } from "storybook-solidjs-vite";

import {
  UiLocaleProvider,
  type UiLocaleCode,
} from "../src/lib/ui-locale.tsx";
import {
  resolveLocaleDirection,
  resolveLocaleLanguageTag,
} from "../src/lib/ui-locale-core.ts";

import "../src/live/style.css";

// Catalog composition from the reviewed pirate-web-solid unified catalog
// model: one place reviews a token on its Foundations page and in every
// screen that uses it, in dark and light, LTR and RTL. Tier order follows
// the recorded hierarchy: Flows (multi-step journeys), Screens (route-level
// views and shells), Parts (feature-scoped components), then the design
// system's Foundations, Components and Patterns.
type ThemeMode = "dark" | "light" | "system";
type DirectionMode = "auto" | "ltr" | "rtl";

// Components and Patterns are isolated fragments. Their host application owns
// the page landmark, heading and region structure; Screens validate those
// rules. Scope only these three page-level rules, never component semantics.
const PAGE_LEVEL_A11Y_RULES = [
  "landmark-one-main",
  "page-has-heading-one",
  "region",
];

const withFragmentA11y = createDecorator((Story, context) => {
  const parts = (context.title ?? "").split("/");
  const tier = ["Screens", "Flows", "Parts"].includes(parts[1])
    ? parts[1]
    : parts[0];
  const current = context.parameters.a11y ?? {};
  const config = current.config ?? {};
  context.parameters.a11y = {
    ...current,
    config: {
      ...config,
      rules: [
        ...(config.rules ?? []),
        ...PAGE_LEVEL_A11Y_RULES.map((id) => ({ id, enabled: tier === "Screens" })),
      ],
    },
  };
  return Story();
});

const withAppDocument = createDecorator((Story, context) => {
  const mode = context.globals.theme as ThemeMode;
  const directionMode = context.globals.direction as DirectionMode;
  const locale = context.globals.locale as UiLocaleCode;
  const root = document.documentElement;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const useDark = mode === "dark" || (mode === "system" && prefersDark);
  const direction =
    directionMode === "auto" ? resolveLocaleDirection(locale) : directionMode;

  root.classList.toggle("light", !useDark);
  root.dataset.theme = useDark ? "dark" : "light";
  root.dir = direction;
  root.lang = resolveLocaleLanguageTag(locale);
  root.dataset.documentVersion = "2";

  return (
    <UiLocaleProvider locale={locale}>
      {Story()}
    </UiLocaleProvider>
  );
});

const preview: Preview = {
  decorators: [withFragmentA11y, withAppDocument],
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Global app theme",
      defaultValue: "dark",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
          { value: "system", title: "System" },
        ],
      },
    },
    direction: {
      name: "Direction",
      description: "Global text direction",
      defaultValue: "auto",
      toolbar: {
        icon: "transfer",
        items: [
          { value: "auto", title: "Auto" },
          { value: "ltr", title: "LTR" },
          { value: "rtl", title: "RTL" },
        ],
      },
    },
    locale: {
      name: "Locale",
      description: "Global story locale",
      defaultValue: "en",
      toolbar: {
        icon: "globe",
        items: [
          { value: "en", title: "English" },
          { value: "ar", title: "Arabic" },
          { value: "zh", title: "Chinese" },
          { value: "pseudo", title: "Pseudo" },
        ],
      },
    },
  },
  initialGlobals: {
    theme: "dark",
    direction: "auto",
    locale: "en",
  },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    options: {
      storySort: {
        // Feature-first: one place per feature, tiers ordered inside it.
        // The design system's shared tiers follow. Tier discipline lives
        // in story tags enforced by scripts/ui/story-conformance.mjs.
        order: [
          "Studying", ["Screens", "Flows", "Parts"],
          "Karaoke", ["Screens", "Flows", "Parts"],
          "Wallet", ["Screens", "Flows", "Parts"],
          "Shell", ["Screens", "Flows", "Parts"],
          "Community", ["Screens", "Flows", "Parts"],
          "Dance", ["Screens", "Flows", "Parts"],
          "Foundations",
          ["Color", "Typography", "Spacing & Sizing", "Radius & Elevation", "Icons", "Motion"],
          "Components",
          ["Actions", "Forms", "Overlays", "Disclosure", "Feedback", "Data Display", "Media"],
          "Patterns",
          ["Forms", "Overlays", "Feedback", "Identity", "Engagement", "Layout", "Navigation"],
          "*",
        ],
      },
    },
  },
};

export default preview;
