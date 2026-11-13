// Additional UNRUN assertions; original c7 stories/assertions remain intact.
import { within } from "storybook/test";
import {
  DanceRepairStory,
  type RepairStoryMode,
} from "../../../test/dance-repair-story-fixtures.tsx";
export default {
  title: "Flows/Dance/Recovery repair",
  parameters: { layout: "fullscreen", docs: { description: { component: "Engineering recovery/denial extensions have no exact Paper frame. Hidden fixture diagnostics are programmatic regression ports, not product controls. Real native video fixture, explicit A endpoint, denial and Blob URL assertions remain. Phone390x844 and exact desktop1280x800 captures require separate review." } } },
};
const render = (mode: RepairStoryMode) => () => (
  <DanceRepairStory mode={mode} />
);
async function until(root: HTMLElement, condition: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (condition()) return;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  throw new globalThis.Error(
    "Expected repaired source page state: " + root.textContent,
  );
}
const findButton = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
const explicitPlay = async ({
  canvasElement: root,
}: {
  canvasElement: HTMLElement;
}) => {
  await until(root, () => !!findButton(root, "Cancel review"));
  if (root.querySelector("details") || root.querySelector("summary"))
    throw new globalThis.Error("Cancel review must be directly visible");
  if (findButton(root, "Submit for review"))
    throw new globalThis.Error("Explicit review A exposed local B submit");
  findButton(root, "Cancel review")!.click();
  const confirmation = () =>
    within(root.ownerDocument.body).queryByRole("dialog", {
      name: "Cancel review of this recording?",
    });
  await until(root, () => {
    const dialog = confirmation();
    return dialog !== null && !!findButton(dialog, "Keep waiting");
  });
  const confirm = findButton(confirmation()!, "Cancel review")!;
  confirm.click();
  await until(
    root,
    () => root.textContent?.includes("Withdrawal pending") === true,
  );
  if (
    root
      .querySelector("[data-fixture-path]")
      ?.textContent?.includes("/explicit_A/withdraw") !== true
  )
    throw new globalThis.Error("Action retargeted from A");
};
export const ExplicitAWithLocalB = {
  render: render("explicit_A_local_B"),
  play: explicitPlay,
};
export const ExplicitAWithSubmittedB = {
  render: render("explicit_A_submitted_B"),
  play: explicitPlay,
};
export const RetainedLocalPreview = {
  render: render("local_original"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    await until(root, () => !!findButton(root, "Preview recording"));
    findButton(root, "Preview recording")!.click();
    await until(
      root,
      () =>
        root
          .querySelector('video[aria-label="Your private recording"]')
          ?.getAttribute("src")
          ?.startsWith("blob:") === true,
    );
    const url = root.querySelector("video")!.getAttribute("src")!;
    (root.querySelector("[data-fixture-refusal]") as HTMLButtonElement).click();
    await until(
      root,
      () => !!root.querySelector('[data-dance-review="anonymous"]'),
    );
    if (root.querySelector("video"))
      throw new globalThis.Error("Local preview survived denial");
    let revoked = false;
    try {
      await fetch(url);
    } catch {
      revoked = true;
    }
    if (!revoked)
      throw new globalThis.Error("Owned original Blob URL was not released");
  },
};
export const MissingOriginal = {
  render: render("local_missing_original"),
  play: async ({ canvasElement: root }: { canvasElement: HTMLElement }) => {
    await until(root, () => !!findButton(root, "Preview recording"));
    findButton(root, "Preview recording")!.click();
    await until(
      root,
      () => root.textContent?.includes("The preview isn’t available") === true,
    );
    if (root.querySelector("video"))
      throw new globalThis.Error("Missing original produced a preview");
    const exit = root.querySelector<HTMLButtonElement>('button[aria-label="Back to dance"]');
    if (!exit) throw new globalThis.Error("Missing original has no direct exit");
    // The normal visual story ends on the actual recovery surface. The same
    // Back/unmount regression runs in dance-missing-original-exit.browser.tsx.
    if (!root.querySelector('[data-dance-review="ready"]') ||
        root.querySelector("[data-fixture-exited]")?.textContent !== "false")
      throw new globalThis.Error("Missing original recovery must remain available");
  },
};
export const PermissionRefused = { render: render("local_permission_refused") };
const refusalPlay = async ({
  canvasElement: root,
}: {
  canvasElement: HTMLElement;
}) => {
  await until(
    root,
    () =>
      !!root.querySelector(
        '[data-dance-review="ready"], [data-dance-result="ready"]',
      ),
  );
  const isReview = !!root.querySelector("[data-dance-review]");
  if (isReview) {
    (
      root.querySelector("[data-fixture-late-read]") as HTMLButtonElement
    ).click();
    await until(
      root,
      () =>
        root.querySelector("[data-fixture-late-waiting]")?.textContent ===
        "true",
    );
  }
  (root.querySelector("[data-fixture-refusal]") as HTMLButtonElement).click();
  await until(
    root,
    () =>
      !!root.querySelector(
        '[data-dance-review="anonymous"], [data-dance-result="anonymous"]',
      ),
  );
  if (isReview) {
    (
      root.querySelector("[data-fixture-late-reply]") as HTMLButtonElement
    ).click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }
  if (
    root.querySelector("video") ||
    findButton(root, "Cancel review") ||
    root.querySelector('[aria-label="Dance review result"]')
  )
    throw new globalThis.Error(
      "Private state survived known HTTP refusal while body stalled",
    );
};
export const ReviewStalled401 = {
  render: render("review_stalled_401"),
  play: refusalPlay,
};
export const ResultStalled403 = {
  render: render("result_stalled_403"),
  play: refusalPlay,
};
