import { DanceAsyncResizeStory } from "../../test/dance-async-resize-story-fixtures.tsx";

export default {
  title: "Flows/Dance/Async resize repair",
  globals: { viewport: { value: "dancePhone" } },
  parameters: {
    layout: "fullscreen",
    viewport: { options: {
      dancePhone: { name: "Dance phone", styles: { width: "390px", height: "844px" } },
      danceDesktop: { name: "Dance desktop", styles: { width: "1280px", height: "800px" } },
    } },
    docs: { description: { component: "UNRUN engineering boundary extensions, no exact Paper frame. Actual product pages/original machine/controllers with named simulated owner/media/camera/HTTP/storage. The play changes a live browse-only scenario during a deferred operation; actual native viewport resize is a separate required Root gate. No original plays or assertions removed. Shared font/harness and design acceptance remain held." } },
  },
};
async function until(root: HTMLElement, check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise<void>(resolve => root.ownerDocument.defaultView!.requestAnimationFrame(() => resolve()));
  }
  throw new globalThis.Error("Deferred original boundary did not settle");
}
function named(root: HTMLElement, text: string) {
  return [...root.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === text && !b.closest("[hidden]"));
}
async function click(root: HTMLElement, text: string) {
  await until(root, () => !!named(root, text) && !named(root, text)!.disabled);
  named(root, text)!.click();
}
function port(root: HTMLElement, name: string) {
  const element = root.querySelector<HTMLButtonElement>("[data-async-" + name + "]");
  if (!element) throw new globalThis.Error("Missing simulated boundary port: " + name);
  element.click();
}
async function verify(root: HTMLElement, submission: boolean) {
  port(root, "inspect");
  await until(root, () => !!root.querySelector("[data-async-snapshot]")?.textContent);
  const saved = JSON.parse(root.querySelector("[data-async-snapshot]")!.textContent!);
  if (saved.captureId !== "capture" || saved.captureUnknown || saved.submission !== "none" || saved.outstanding)
    throw new globalThis.Error("Resize changed or stranded the retained original");
  if (submission && saved.uploadRequest !== "SIMULATED_original_media")
    throw new globalThis.Error("Resize lost original media identity");
  for (const name of ["commands", "posts", "native"])
    if (root.querySelector("[data-async-" + name + "]")?.textContent !== "0")
      throw new globalThis.Error("Eligibility loss allowed a fresh side effect: " + name);
}
async function submitPlay(root: HTMLElement) {
  if (root.ownerDocument.defaultView!.matchMedia("(min-width: 768px)").matches) {
    await until(root, () => !!root.querySelector('[data-dance-review="ready"]'));
    if (named(root, "Submit for review")) throw new globalThis.Error("Desktop exposed fresh submit");
    await verify(root, true); return;
  }
  await until(root, () => !!named(root, "Submit for review"));
  port(root, "arm"); await click(root, "Submit for review");
  await until(root, () => root.querySelector("[data-async-held]")?.textContent === "true");
  port(root, "deny"); port(root, "release");
  await until(root, () => root.querySelector("[data-async-rejected]")?.textContent === "true");
  await until(root, () => root.textContent?.includes("Your submission needs confirmation. Resume to continue.") === true);
  await verify(root, true);
}
async function activationPlay(root: HTMLElement) {
  if (root.ownerDocument.defaultView!.matchMedia("(min-width: 768px)").matches) {
    await until(root, () => root.textContent?.includes("Recording is available on mobile.") === true);
    if (named(root, "Record") || root.querySelector('video[aria-label="Camera preview"]'))
      throw new globalThis.Error("Desktop initialized capture");
    port(root, "inspect");
    await until(root, () => !!root.querySelector("[data-async-snapshot]")?.textContent);
    if (JSON.parse(root.querySelector("[data-async-snapshot]")!.textContent!).captureId !== null)
      throw new globalThis.Error("Desktop created a reservation");
    return;
  }
  await click(root, "Accept and continue"); await click(root, "Record");
  await until(root, () => root.querySelector("[data-async-held]")?.textContent === "true");
  port(root, "deny"); port(root, "release");
  await until(root, () => root.querySelector("[data-async-rejected]")?.textContent === "true");
  await until(root, () => !!root.querySelector('[data-dance-recorder="recovery"]'));
  await verify(root, false);
  if (named(root, "Submit for review")) throw new globalThis.Error("Denied capture produced a submission");
}
export const DeferredSubmissionBecomesBrowseOnly = {
  render: () => <DanceAsyncResizeStory scenario="submission" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => submitPlay(canvasElement),
};
export const DeferredActivationBecomesBrowseOnly = {
  render: () => <DanceAsyncResizeStory scenario="activation" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => activationPlay(canvasElement),
};
