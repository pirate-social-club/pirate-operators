import type { StorybookConfig } from "storybook-solidjs-vite";
import remarkGfm from "remark-gfm";

// Unified catalog on the reviewed pirate-web-solid model: the app's stories
// and the vendored design system that backs them in one place, so a token
// can be reviewed on its Foundations page and in the screens that use it.
// The vendored package keeps its own .storybook inside the tarball for
// isolated review; this is the source of truth for the product catalog.
// The addon-docs lock is the pinned proposal the storybook lane prepared;
// versions match the vendored package's own devDependencies.
const config: StorybookConfig = {
  stories: [
    "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../node_modules/@pirate/web-solid-ui/src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../node_modules/@pirate/web-solid-ui/src/**/*.mdx",
  ],
  addons: [
    {
      name: "@storybook/addon-docs",
      options: {
        mdxPluginOptions: {
          mdxCompileOptions: {
            remarkPlugins: [remarkGfm],
          },
        },
      },
    },
    "@storybook/addon-a11y",
  ],
  staticDirs: ["../src/live/public", "./public"],
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
