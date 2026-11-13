/** UNRUN. Focused exit regression separated from the normal visual story.
 * Actual page/controller/client and original fixture; named simulated owner,
 * HTTP and memory storage. Uses the existing genuine neutral media fixture.
 * No new navigation feature, placeholder, device or production authority. */
import { render } from "@solidjs/web";
import { DanceRepairStory } from "./dance-repair-story-fixtures.tsx";

export async function runDanceMissingOriginalExitBrowserCase(host: HTMLElement) {
  const dispose = render(() => <DanceRepairStory mode="local_missing_original" />, host);
  const until = async (condition: () => boolean) => {
    for (let n = 0; n < 300; n++) {
      if (condition()) return;
      await new Promise<void>(resolve => host.ownerDocument.defaultView!.requestAnimationFrame(() => resolve()));
    }
    throw new globalThis.Error("Expected repaired source page state: " + host.textContent);
  };
  const findButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent?.trim() === text);
  const noRecapture = () => {
    if (host.querySelector('video[aria-label="Camera preview"]') || findButton("Record") || findButton("Record again"))
      throw new globalThis.Error("Missing original recovery cannot recapture");
  };
  try {
    await until(() => !!findButton("Preview recording"));
    findButton("Preview recording")!.click();
    await until(() => host.textContent?.includes("The preview isn’t available") === true);
    if (host.querySelector("video"))
      throw new globalThis.Error("Missing original produced a preview");
    noRecapture();
    const exit = host.querySelector<HTMLButtonElement>('button[aria-label="Back to dance"]');
    if (!exit) throw new globalThis.Error("Missing original has no direct exit");
    if (!host.querySelector('[data-dance-review="ready"]') ||
        host.querySelector("[data-fixture-exited]")?.textContent !== "false")
      throw new globalThis.Error("Missing original recovery must remain available");
    // Preserve the exact original Back + successful unmount assertion. An
    // intentionally exited isolated fixture is not an owner visual end state.
    exit.click();
    await until(() => !host.querySelector("[data-dance-review]") && host.querySelector("[data-fixture-exited]")?.textContent === "true");
    if (host.querySelector("video"))
      throw new globalThis.Error("Missing original produced a preview");
    noRecapture();
    return { exited: true, previewCreated: false, recaptured: false,
      evidence: "actual page exit and fixture unmount over named simulated ports; no render or storage acceptance claim" };
  } finally { dispose(); }
}
