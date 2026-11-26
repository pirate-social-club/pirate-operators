import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { expect, fn, userEvent, within } from "storybook/test";
import { ChooseHandle } from "./choose-handle.tsx";
import type { MembershipState } from "./community-membership.ts";

const meta = {
  title: "Community/Flows/Optional name",
  // The tier lives in metadata so the sidebar can group feature-first.
  tags: ["flow"],
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Actual optional-name component with explicit UI fixtures. Membership and name responses are supplied presentation states. No authentication, backend, signing or chain operation runs here." } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const initial = (unavailable: boolean): MembershipState => ({
  ownerKey: "preview-only-account",
  join: { schema: "pirate.community-join/1", ownerScope: "preview-only", revision: 1,
    state: "accepted", receipt: { joinId: "preview-only-join", acceptedAtMs: 1 } },
  name: { schema: "pirate.member-name/1", ownerScope: "preview-only", revision: 1,
    recipient: "0x1111111111111111111111111111111111111111", tld: "preview",
    ...(unavailable
      ? { state: "blocked", claim: null, reason: "issuer_unavailable",
          correction: "Naming is unavailable in this UI preview. Membership remains accepted." } as const
      : { state: "idle", claim: null } as const) },
  joining: false, naming: false, nameOpen: true,
  joinUncertain: false, nameUncertain: false, error: null,
});

function Preview(props: { unavailable: boolean }) {
  const [state, setState] = createSignal(initial(props.unavailable));
  let returnTarget: HTMLDivElement | undefined;
  return <div class="min-h-screen bg-background text-foreground"
    tabindex={-1} ref={(node) => { returnTarget = node; }}>
    <ChooseHandle communityName="Preview fixture" state={state()}
      returnFocus={() => returnTarget}
      onClose={() => setState({ ...state(), nameOpen: false })}
      onPrepare={fn()} onConsent={fn()} onCheck={fn()} onReconcile={fn()} />
  </div>;
}

export const ChooseName: Story = {
  render: () => <Preview unavailable={false} />,
  play: async ({ canvasElement }) => {
    const dialogElement = await within(canvasElement.ownerDocument.body).findByRole(
      "dialog",
      { name: "Choose your name" },
    );
    const dialog = within(dialogElement);
    await expect(dialogElement).toBeVisible();
    const name = dialog.getByLabelText("Name", { exact: true });
    // The failure guard first: an invalid label keeps the submit disabled.
    await userEvent.type(name, "abc");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    const submit = dialog.getByRole("button", { name: "Get name" });
    await expect(submit).toBeDisabled();
    // A valid label takes the production submit path.
    await userEvent.clear(name);
    await userEvent.type(name, "fixture-member");
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
  },
};
export const NamingUnavailable: Story = {
  render: () => <Preview unavailable={true} />,
};
