import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { CommunityAppShell } from "../live/app-shell.tsx";
import {
  createCommunityShellStoryClient,
  type CommunityShellStoryState,
} from "./community-shell-story-client.ts";

function ShellRouteFixture(props: CommunityShellStoryState) {
  const client = createCommunityShellStoryClient(props);
  return (
    <CommunityAppShell
      {...client.snapshot()}
      onSignIn={() => void client.signIn()}
    >
      <main class="mx-auto max-w-3xl p-6">
        <h1 class="text-2xl font-semibold">Community feed fixture</h1>
        <p class="mt-3 text-muted-foreground">
          Presentation fixture inside the production community shell.
          Navigation destinations are real app links; this story does not
          exercise routing or load a community.
        </p>
      </main>
    </CommunityAppShell>
  );
}

const meta = {
  title: "Shell/Screens/Community app shell",
  tags: ["screen"],
  component: ShellRouteFixture,
  args: {
    name: "Catalog community",
    communityId: "catalog-community",
    view: "home",
    walletPage: false,
    rewards: true,
    practiceOpen: false,
    signedIn: false,
    ready: true,
    busy: false,
    canSignIn: true,
    accountSeed: "catalog-preview",
  },
  render: (args) => <ShellRouteFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Renders the production CommunityAppShell from a story-only session/community client boundary. Account and readiness values come from the client snapshot, not shell props in the story body. No SDK, credentials, network or service runs. Navigation links are not clicked; this is shell coverage, not complete route parity.",
      },
    },
  },
} satisfies Meta<typeof ShellRouteFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anonymous: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
export const ResolvingSession: Story = { args: { ready: false } };
export const Busy: Story = { args: { busy: true } };
