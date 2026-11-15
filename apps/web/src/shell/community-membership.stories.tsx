import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import { ChooseHandle } from "./choose-handle.tsx";
import type { MembershipState } from "./community-membership.ts";

const meta = {
  title: "Checkpoint/Community/Optional name",
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
  let trigger: HTMLButtonElement | undefined;
  return <div class="min-h-screen bg-background p-6 text-foreground">
    <p role="note" class="mb-4">UI fixture only. Controls do not join a community or issue a name.</p>
    <button ref={(node) => { trigger = node; }}
      onClick={() => setState({ ...state(), nameOpen: true })}>Open optional-name preview</button>
    <ChooseHandle communityName="Preview fixture" state={state()}
      returnFocus={() => trigger}
      onClose={() => setState({ ...state(), nameOpen: false })}
      onPrepare={fn()} onConsent={fn()} onCheck={fn()} onReconcile={fn()} />
  </div>;
}

export const ChooseName: Story = { render: () => <Preview unavailable={false} /> };
export const NamingUnavailable: Story = { render: () => <Preview unavailable={true} /> };
