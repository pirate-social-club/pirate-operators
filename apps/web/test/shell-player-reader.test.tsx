// UNRUN. Actual custom SongPlayer mounted with explicit media method doubles.
// Native decoding, playback timing and keyboard seeking remain browser gates.
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { ShellPlayerReaderInput } from "./shell-player-inputs.tsx";
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function mount(
  props: {
    bRefuses?: boolean;
    aImmediate?: boolean;
    sameReader?: boolean;
  } = {},
) {
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(render(() => <ShellPlayerReaderInput {...props} />, host));
  return {
    host,
    pause,
    load,
    audio: () => host.querySelector<HTMLAudioElement>("audio")!,
    state: () => host.querySelector<HTMLElement>("[data-reader-fixture]")!,
    click: (name: string) => {
      const button = [...host.querySelectorAll("button")].find(
        (button) =>
          button.getAttribute("aria-label") === name ||
          button.textContent === name,
      );
      expect(button).toBeDefined();
      button!.click();
    },
  };
}
for (const mode of ["replace", "remount"] as const) {
  test(`same post ${mode}: B resolves before late A; old media events cannot affect B`, async () => {
    const { host, state, audio, click, pause, load } = mount();
    await vi.waitFor(() => expect(audio()).not.toBeNull());
    const old = audio();
    click("Play Fixture same post");
    await vi.waitFor(() => expect(state().dataset.aCalls).toBe("1"));
    if (mode === "remount") {
      click("Fixture hide player");
      await vi.waitFor(() => expect(host.querySelector("audio")).toBeNull());
      click("Fixture show reader B");
    } else click("Fixture replace reader B");
    await vi.waitFor(() => {
      expect(audio()).not.toBeNull();
      expect(audio()).not.toBe(old);
    });
    expect(old.getAttribute("src")).toBeNull();
    expect(load.mock.contexts).toContain(old);
    expect(pause.mock.contexts).toContain(old);
    expect(audio().getAttribute("src")).toBeNull();
    click("Play Fixture same post");
    await vi.waitFor(() => expect(audio().src).toMatch(/fixture-b\.wav$/));
    click("Fixture resolve reader A");
    // Let both the reader and actual player await continuations settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(audio().src).toMatch(/fixture-b\.wav$/);
    pause.mockClear();
    load.mockClear();
    for (const type of [
      "play",
      "playing",
      "waiting",
      "stalled",
      "pause",
      "emptied",
      "loadedmetadata",
      "timeupdate",
      "error",
      "seeked",
    ])
      old.dispatchEvent(new Event(type));
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Audio could not be loaded.");
    expect(audio().src).toMatch(/fixture-b\.wav$/);
    expect(
      host.querySelector('[aria-label="Pause Fixture same post"]'),
    ).toBeNull(); // no genuine playing event
    click("Fixture hide player");
    await vi.waitFor(() => expect(host.querySelector("audio")).toBeNull());
    click("Fixture show reader A");
    await vi.waitFor(() => expect(audio().src).toMatch(/fixture-a\.wav$/));
    expect(state().dataset.aCalls).toBe("1");
    expect(state().dataset.bCalls).toBe("1");
  });
  for (const cached of [false, true]) {
    test(`same post ${mode}: B refusal cannot inherit ${cached ? "cached" : "late"} A`, async () => {
      const { host, state, audio, click } = mount({
        bRefuses: true,
        aImmediate: cached,
      });
      await vi.waitFor(() => expect(audio()).not.toBeNull());
      click("Play Fixture same post");
      await vi.waitFor(() => expect(state().dataset.aCalls).toBe("1"));
      if (cached)
        await vi.waitFor(() => expect(audio().src).toMatch(/fixture-a\.wav$/));
      const old = audio();
      if (mode === "remount") {
        click("Fixture hide player");
        await vi.waitFor(() => expect(host.querySelector("audio")).toBeNull());
        click("Fixture show reader B");
      } else click("Fixture replace reader B");
      await vi.waitFor(() => {
        expect(audio()).not.toBeNull();
        expect(audio()).not.toBe(old);
      });
      expect(audio().getAttribute("src")).toBeNull();
      click("Play Fixture same post");
      await vi.waitFor(() =>
        expect(host.textContent).toContain("This song could not be played."),
      );
      if (!cached) click("Fixture resolve reader A");
      await Promise.resolve();
      await Promise.resolve();
      expect(audio().getAttribute("src")).toBeNull();
      click("Retry playback");
      await vi.waitFor(() => expect(state().dataset.bCalls).toBe("2"));
      expect(audio().getAttribute("src")).toBeNull();
      expect(old.getAttribute("src")).toBeNull();
    });
  }
}
test("same immutable reader receives late access after remount without a second request", async () => {
  const { host, state, audio, click } = mount({ sameReader: true });
  await vi.waitFor(() => expect(audio()).not.toBeNull());
  click("Play Fixture same post");
  await vi.waitFor(() => expect(state().dataset.aCalls).toBe("1"));
  click("Fixture hide player");
  await vi.waitFor(() => expect(host.querySelector("audio")).toBeNull());
  click("Fixture show reader B");
  await vi.waitFor(() => expect(audio()).not.toBeNull());
  click("Fixture resolve reader A");
  await vi.waitFor(() => expect(audio().src).toMatch(/fixture-a\.wav$/));
  expect(state().dataset.aCalls).toBe("1");
  expect(state().dataset.bCalls).toBe("0");
});
