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
          styles: { width: "1280px", height: "800px" },
        },
      },
    },
    docs: {
      description: {
        component:
          "Actual source compositions/statechart with simulated decentralized ports and a canvas camera. Owner correction: phone Paper flow; desktop is reference browsing only. Matched captures required at390x844 and1280x800, plus1440 responsive. Tests/renders are UNRUN; no native, provider, persistence, canonical or public-rights acceptance.",
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
  throw new globalThis.Error("Expected source button: " + label);
}
// These are active negative assertions, not a skipped desktop play. Phone
// cases retain every original capture/recovery/submission/privacy assertion.
async function assertDesktopNoPosting(root: HTMLElement) {
  if (!root.ownerDocument.defaultView!.matchMedia("(min-width: 768px)").matches) return false;
  for (let n = 0; n < 300; n++) {
    if (root.querySelector('[data-dance-selection="ready"]')) break;
    if (n === 299) throw new globalThis.Error("Desktop reference selection did not settle");
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  const forbidden = ["Do this dance", "Accept and continue", "Record", "Resume upload", "Submit for review"];
  if ([...root.querySelectorAll("button")].some(b => forbidden.includes(b.textContent?.trim() ?? "")) || root.querySelector('video[aria-label="Camera preview"]')) throw new globalThis.Error("Desktop exposed new Dance posting");
  if (!root.querySelector('[data-dance-selection="ready"]')?.textContent?.includes("Recording is available on mobile.")) throw new globalThis.Error("Desktop mobile availability missing");
  return true;
}
async function frame(root: HTMLElement) {
  (await button(root, "Open Dance 1 · 8.013 s")).click();
  if (await assertDesktopNoPosting(root)) return false;
  (await button(root, "Do this dance")).click();
  (await button(root, "Accept and continue")).click();
  await button(root, "Record");
  if (root.textContent?.includes("opening cue"))
    throw new globalThis.Error("No-pose source must not invent a cue");
  return true;
}
export const ChooseAndFrame = {
  render: render("camera"),
  globals: { viewport: { value: "dancePhone" } },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) =>
    frame(canvasElement),
};
export const Desktop = {
  render: render("desktop"),
  globals: { viewport: { value: "danceDesktop" } },
};
export const RecordAndReview = {
  render: render("camera"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    if (!(await frame(root))) return;
    (await button(root, "Record")).click();
    const submit = await button(root, "Submit for review");
    if (
      submit.disabled ||
      !root.querySelector('video[aria-label="Your private recording"]')
    )
      throw new globalThis.Error(
        "Explicit source take preview/submission required",
      );
    const media = root.querySelector('video[aria-label="Your private recording"]');
    if (media?.hasAttribute("controls") || !root.querySelector('button[aria-label="Back to dance"]') || ![...root.querySelectorAll("button")].some(b => b.textContent?.trim() === "Play recording")) throw new globalThis.Error("Review must keep full-media playback and direct exit");
    for (const copy of ["Perform the whole selected dance, keeping your full body visible.", "This recording is private. Public posting is not enabled.", "Same rewards either way."]) if (root.textContent?.includes(copy)) throw new globalThis.Error("Rejected product copy returned");
    if (root.textContent?.includes("Show publicly if it passes"))
      throw new globalThis.Error("Held public choice must not be enabled");
  },
};
export const SavedOriginal = {
  render: render("saved"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    (await button(root, "Open Dance 1 · 8.013 s")).click();
    if (await assertDesktopNoPosting(root)) return;
    (await button(root, "Do this dance")).click();
    (await button(root, "Resume upload")).click();
    await button(root, "Submit for review");
    if (
      [...root.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Record",
      )
    )
      throw new globalThis.Error("Recovery cannot recapture");
  },
};
export const UnknownSubmission = {
  render: render("unknown"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    if (!(await frame(root))) return;
    (await button(root, "Record")).click();
    (await button(root, "Submit for review")).click();
    (await button(root, "Resume submission")).click();
    await button(root, "Done");
    if (root.textContent?.includes("Passed"))
      throw new globalThis.Error("An acknowledged submission is not a verdict");
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
    if (!(await frame(root))) return;
    (await button(root, "Record")).click();
    await button(root, "Submit for review");
    window.dispatchEvent(new Event("online"));
    await button(root, "Sign in");
    if (root.querySelector("video"))
      throw new globalThis.Error(
        "Denial must clear private camera/media/result state",
      );
  },
};
export const Loading = { render: render("loading") };
export const Anonymous = { render: render("anonymous") };
export const Error = { render: render("error") };
export const AdmissionHeld = { render: render("held") };
