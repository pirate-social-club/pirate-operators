// UNRUN. Existing single-worker component harness; actual source, offline HTTP.
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileRecoveryInput } from "./profile-recovery-inputs.tsx";
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
function mount(failureAt: "owner" | "receipt", status: number, body: string) {
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <ProfileRecoveryInput
          failureAt={failureAt}
          status={status}
          body={body}
        />
      ),
      host,
    ),
  );
  return {
    host,
    state: () => host.querySelector<HTMLElement>("[data-profile-recovery]")!,
    click: (text: string) => {
      const button = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === text,
      );
      expect(button).toBeDefined();
      button!.click();
    },
  };
}
test.each([401, 403])(
  "actual ownerAccountId and source Profile mask non-JSON %s",
  async (status) => {
    const { host, state, click } = mount(
      "owner",
      status,
      "<html>Sign in</html>",
    );
    await vi.waitFor(() => expect(state().dataset.ownerPresent).toBe("true"));
    expect(host.querySelector("[data-profile-layout]")).not.toBeNull();
    click("Fixture lose owner authority");
    await vi.waitFor(() =>
      expect(state().dataset.view).toBe(
        status === 401 ? "anonymous" : "unavailable",
      ),
    );
    expect(state().dataset.ownerPresent).toBe("false");
    expect(host.querySelector("[data-profile-layout]")).toBeNull();
    expect(host.textContent).not.toContain("private-fixture-account");
    if (status === 403)
      expect(host.querySelector('a[href="/#/settings"]')).not.toBeNull();
    click("Fixture restore authority");
    await vi.waitFor(() => expect(state().dataset.ownerPresent).toBe("true"));
  },
);
test.each([
  [429, '{"error":"rate_limited"}'],
  [401, "<html>Sign in</html>"],
  [403, ""],
] as const)(
  "mounted lost ACK/receipt %s retains recovery and blocks another write",
  async (status, body) => {
    const { host, state, click } = mount("receipt", status, body);
    await vi.waitFor(() => expect(state().dataset.ownerPresent).toBe("true"));
    click("Fixture save");
    await vi.waitFor(() => expect(state().dataset.mutation).toBe("unknown"));
    click("Fixture retry receipt");
    await vi.waitFor(() => expect(state().dataset.receiptReads).toBe("2"));
    await vi.waitFor(() => expect(state().dataset.mutation).toBe("unknown"));
    if (status === 401 || status === 403) {
      await vi.waitFor(() =>
        expect(state().dataset.ownerPresent).toBe("false"),
      );
      expect(host.querySelector("[data-profile-layout]")).toBeNull();
    }
    click("Fixture attempt new save");
    await vi.waitFor(() =>
      expect(state().dataset.secondSaveBlocked).toBe("true"),
    );
    expect(state().dataset.saves).toBe("1");
    click("Fixture restore authority");
    await vi.waitFor(() => expect(state().dataset.mutation).toBe("idle"));
    expect(state().dataset.saves).toBe("1");
    expect(state().dataset.ownerPresent).toBe("true");
    expect(host.textContent).toContain("Fixture profile");
    expect(host.textContent).not.toContain("private-fixture-account");
  },
);
