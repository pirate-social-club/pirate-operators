// Actual source page lifetime with an explicitly unresolved in-memory HTTP port.
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { StudyPage } from "../src/study/page.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <StudyPage
        account="fixture-account"
        postId="fixture-post"
        title="Fixture song"
        csrf="fixture-csrf"
        onExit={() => {}}
      />
    ),
    host,
  );
  disposers.push(dispose);
  return { host, dispose };
}
test("the actual Study page starts loading after component construction", async () => {
  const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
  vi.stubGlobal("fetch", transport);
  const { host } = mount();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  expect(host.querySelector('[aria-label="Exit study"]')).not.toBeNull();
});
test("disposing Study before its first load never dispatches private HTTP", async () => {
  const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
  vi.stubGlobal("fetch", transport);
  const { dispose } = mount();
  dispose();
  disposers.pop();
  await Promise.resolve();
  expect(transport).not.toHaveBeenCalled();
});
