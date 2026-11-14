/** UNRUN Root isolated-browser port. Real window.matchMedia/viewport changes,
 * actual pages/controllers/machine; named simulated camera/guide/owner/storage.
 * Driver must resize the actual page, never a flag, timer or patched matchMedia.
 * No shared harness is mounted/changed by this source packet. */
import { render } from "@solidjs/web";
import { DanceAsyncResizeStory } from "./dance-async-resize-story-fixtures.tsx";

export async function runDanceAsyncResizeBrowserCase(
  host: HTMLElement,
  scenario: "submission" | "activation",
  driver: { resize(width: number, height: number): Promise<void> },
) {
  const view = host.ownerDocument.defaultView!;
  if (view !== window || view.matchMedia("(min-width: 768px)").matches)
    throw Error("Case requires the actual product window at initial phone dimensions");
  const initial = { width: view.innerWidth, height: view.innerHeight };
  const dispose = render(() => <DanceAsyncResizeStory scenario={scenario} />, host);
  const until = async (check: () => boolean) => {
    for (let n = 0; n < 300; n++) {
      if (check()) return;
      await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
    }
    throw Error("Actual deferred resize composition did not settle");
  };
  const named = (name: string) => [...host.querySelectorAll("button")]
    .find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name && !b.closest("[hidden]"));
  const click = async (name: string) => {
    await until(() => !!named(name) && !named(name)!.disabled);
    named(name)!.click();
  };
  const port = (name: string) => {
    const b = host.querySelector<HTMLButtonElement>("[data-async-" + name + "]");
    if (!b) throw Error("Missing simulated boundary port");
    b.click();
  };
  try {
    if (scenario === "submission") {
      await until(() => !!named("Submit for review")); port("arm");
      await click("Submit for review");
    } else {
      await click("Accept and continue"); await click("Record");
    }
    await until(() => host.querySelector("[data-async-held]")?.textContent === "true");
    await driver.resize(1280, 800);
    if (view.innerWidth !== 1280 || view.innerHeight !== 800 || !view.matchMedia("(min-width: 768px)").matches)
      throw Error("Driver did not resize the actual product window");
    // Do not flip the simulated browse-only port: the product must consult
    // the actual now-desktop window after its pending await.
    port("release");
    await until(() => scenario === "submission"
      ? host.textContent?.includes("Your submission needs confirmation. Resume to continue.") === true
      : !!host.querySelector('[data-dance-recorder="recovery"]'));
    port("inspect");
    await until(() => !!host.querySelector("[data-async-snapshot]")?.textContent);
    const saved = JSON.parse(host.querySelector("[data-async-snapshot]")!.textContent!);
    if (saved.captureId !== "capture" || saved.captureUnknown || saved.submission !== "none" || saved.outstanding)
      throw Error("Actual resize changed or stranded the retained identity");
    if (scenario === "submission" && saved.uploadRequest !== "SIMULATED_original_media")
      throw Error("Actual resize lost original upload identity");
    for (const name of ["commands", "posts", "native"])
      if (host.querySelector("[data-async-" + name + "]")?.textContent !== "0")
        throw Error("Actual resize admitted a fresh side effect");
    return { scenario, initial, final: { width: view.innerWidth, height: view.innerHeight },
      freshCommands: 0, freshPosts: 0, freshNativeCapture: 0,
      evidence: "actual viewport/pages; named simulated owner/transport/storage/guide/camera; no provider or visual acceptance" };
  } finally { dispose(); await driver.resize(initial.width, initial.height); }
}
