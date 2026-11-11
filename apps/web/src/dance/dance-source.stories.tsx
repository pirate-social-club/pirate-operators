// CSF inputs/assertions adapted from actual c7 Flows/Dance/Recording stories.
// All ports are named simulations; no physical/storage/chain/provider acceptance.
import {
  DanceStory,
  type DanceStoryMode,
} from "../../test/dance-story-fixtures.tsx";
export default {
  title: "Flows/Dance/Recording",
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        dancePhone: {
          name: "Dance phone",
          styles: { width: "390px", height: "844px" },
        },
        danceDesktop: {
          name: "Dance desktop",
          styles: { width: "1440px", height: "1000px" },
        },
      },
    },
    docs: {
      description: {
        component:
          "Actual source compositions/statechart with simulated decentralized ports and a canvas camera. Tests/renders are UNRUN; no native, provider, persistence, canonical or public-rights acceptance.",
      },
    },
  },
};
const render = (mode: DanceStoryMode) => () => <DanceStory mode={mode} />;
async function button(root: HTMLElement, label: string) {
  for (let n = 0; n < 300; n++) {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim() === label,
    );
    if (found) return found;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  throw Error("Expected source button: " + label);
}
async function frame(root: HTMLElement) {
  (await button(root, "Open dance 1")).click();
  (await button(root, "Do this dance")).click();
  (await button(root, "Accept and continue")).click();
  await button(root, "Record");
  if (root.textContent?.includes("opening cue"))
    throw Error("No-pose source must not invent a cue");
}
export const ChooseAndFrame = {
  render: render("camera"),
  globals: { viewport: { value: "dancePhone" } },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) =>
    frame(canvasElement),
};
export const Desktop = {
  render: render("camera"),
  globals: { viewport: { value: "danceDesktop" } },
};
export const RecordAndReview = {
  render: render("camera"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    await frame(root);
    (await button(root, "Record")).click();
    const submit = await button(root, "Submit for review");
    if (
      submit.disabled ||
      !root.querySelector('video[aria-label="Your private recording"]')
    )
      throw Error("Explicit source take preview/submission required");
    if (root.textContent?.includes("Show publicly if it passes"))
      throw Error("Held public choice must not be enabled");
  },
};
export const SavedOriginal = {
  render: render("saved"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    (await button(root, "Open dance 1")).click();
    (await button(root, "Do this dance")).click();
    (await button(root, "Resume upload")).click();
    await button(root, "Submit for review");
    if (
      [...root.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Record",
      )
    )
      throw Error("Recovery cannot recapture");
  },
};
export const UnknownSubmission = {
  render: render("unknown"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    await frame(root);
    (await button(root, "Record")).click();
    (await button(root, "Submit for review")).click();
    (await button(root, "Resume submission")).click();
    await button(root, "Done");
    if (root.textContent?.includes("Passed"))
      throw Error("An acknowledged submission is not a verdict");
  },
};
export const PermissionRefused = { render: render("permission") };
export const AlreadyWaiting = { render: render("pending") };
export const OwnerCannotRecord = { render: render("owner") };
export const SlowProcessing = { render: render("slow") };
export const OfflineThenReconnect = { render: render("offline") };
export const DeniedAfterPrivateLoad = {
  render: render("denied_after_load"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    await frame(root);
    (await button(root, "Record")).click();
    await button(root, "Submit for review");
    window.dispatchEvent(new Event("online"));
    await button(root, "Sign in");
    if (root.querySelector("video"))
      throw Error("Denial must clear private camera/media/result state");
  },
};
export const Loading = { render: render("loading") };
export const Anonymous = { render: render("anonymous") };
export const Error = { render: render("error") };
export const AdmissionHeld = { render: render("held") };
