import type { Preview } from "storybook-solidjs-vite";
import { createDecorator } from "storybook-solidjs-vite";
import "../src/live/style.css";

const withAppDocument = createDecorator((Story) => {
  const root = document.documentElement;
  root.lang = "en";
  root.dir = "ltr";
  root.classList.add("dark");
  root.classList.remove("light");
  root.dataset.theme = "dark";
  document.body.dataset.documentVersion = "2";
  return Story();
});

const preview: Preview = {
  decorators: [withAppDocument],
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
  },
};

export default preview;
