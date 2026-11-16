import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { CommunityAppShell } from "../live/app-shell.tsx";

function ShellFixture(props: {
  signedIn: boolean;
  ready: boolean;
  busy: boolean;
  onSignIn: () => void;
}) {
  return (
    <CommunityAppShell
      name="Catalog community"
      communityId="catalog-community"
      view="home"
      walletPage={false}
      rewards
      practiceOpen={false}
      signedIn={props.signedIn}
      ready={props.ready}
      busy={props.busy}
      canSignIn
      accountSeed="catalog-preview"
      onSignIn={props.onSignIn}
    >
      <main class="mx-auto max-w-3xl p-6">
        <h1 class="text-2xl font-semibold">Community feed fixture</h1>
        <p class="mt-3 text-muted-foreground">
          Presentation fixture inside the production community shell.
          Navigation destinations are real app links; this story does not
          exercise routing, authenticate an account or load a community.
        </p>
      </main>
    </CommunityAppShell>
  );
}

const meta = {
  title: "Screens/Shell/Community app shell",
  component: ShellFixture,
  args: { signedIn: false, ready: true, busy: false, onSignIn: fn() },
  render: (args) => <ShellFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Imports the CommunityAppShell used by the live entry. Account and readiness values are UI fixtures. No SDK, credentials or service runs. Navigation links are not clicked by a play function. This is shell coverage, not complete route or Paper parity.",
      },
    },
  },
} satisfies Meta<typeof ShellFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anonymous: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
export const ResolvingSession: Story = { args: { ready: false } };
export const Busy: Story = { args: { busy: true } };
