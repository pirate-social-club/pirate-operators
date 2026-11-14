/** UNRUN. Coordinator isolated browser harness port. Actual product composition
 * with explicitly simulated authenticated owner/catalogue ports. No camera,
 * provider, server acceptance or visual parity is simulated as success. */
import { render } from "@solidjs/web";
import { DanceSongPage } from "../src/dance/source/dance-song-page.tsx";
import { simulatedSource, scope, consent } from "./dance-source-fixtures.ts";

export async function runDancePaperDesktopBrowserCase(host: HTMLElement, options: { browseOnly?: boolean } = {}) {
  const view = host.ownerDocument.defaultView!;
  if (!options.browseOnly && !view.matchMedia("(min-width: 768px)").matches)
    throw Error("This case requires an actual desktop viewport");
  const f = simulatedSource();
  let reservations = 0;
  const dispose = render(() => <DanceSongPage
    browseOnly={options.browseOnly}
    communityId={scope.communityId} songKey={scope.songKey}
    account={{ current: () => scope, load: async () => scope, subscribe: () => () => {} }}
    catalogue={{ options: async () => ({ choices: [{ ...scope, title: "Fixture song", durationMs: f.c.durationSamples / 48, playback: "ready", recordingAllowed: true }], consent, owner: false, cursor: null }), latest: async () => null }}
    playback={f.ports.playback}
    source={() => { reservations++; throw Error("Desktop must never construct a posting source"); }}
    onBack={() => {}} onSignIn={() => {}}
  />, host);
  const settle = async (condition: () => boolean) => {
    for (let n = 0; n < 300; n++) {
      if (condition()) return;
      await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
    }
    throw Error("Actual desktop composition did not settle");
  };
  try {
    await settle(() => !!host.querySelector('button[aria-label="Open Dance 1 · 8.013 s"]'));
    (host.querySelector('button[aria-label="Open Dance 1 · 8.013 s"]') as HTMLButtonElement).click();
    await settle(() => !!host.querySelector('[data-dance-selection="ready"]'));
    const forbidden = ["Do this dance", "Accept and continue", "Record", "Submit for review"];
    if ([...host.querySelectorAll("button")].some(b => forbidden.includes(b.textContent?.trim() ?? ""))) throw Error("Desktop exposed new posting");
    if (!host.querySelector('[data-dance-selection="ready"]')?.textContent?.includes("Recording is available on mobile.")) throw Error("Desktop selection lost its mobile availability notice");
    if (host.querySelector('video[aria-label="Camera preview"]') || reservations !== 0) throw Error("Desktop initialized capture authority");
    (host.querySelector('button[aria-label="Back to dances"]') as HTMLButtonElement).click();
    await settle(() => !host.querySelector('[aria-label="Selected dance"]'));
    return { status: "passed", actualViewport: { width: view.innerWidth, height: view.innerHeight }, browseOnly: !!options.browseOnly, reservations, evidence: "actual composition; simulated owner/catalogue only; no visual acceptance" };
  } finally { dispose(); }
}
