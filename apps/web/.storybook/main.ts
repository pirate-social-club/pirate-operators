import type { StorybookConfig } from "storybook-solidjs-vite";

// Adapted from pirate-web-solid c7cb8783 .storybook/main.ts.
// Requires the separate exact-pinned addon/lock proposal to be composed.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(js|jsx|mjs|cjs|ts|tsx|mts|cts)"],
  addons: ["@storybook/addon-a11y"],
  staticDirs: ["../src/live/public"],
  framework: {
    name: "storybook-solidjs-vite",
    options: {
      builder: {
        viteConfigPath: ".storybook/vite.config.ts",
      },
    },
  },
};

export default config;
