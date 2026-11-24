import { createSignal } from "solid-js";

export interface CommunityShellStoryState {
  name: string;
  communityId: string;
  view: "home";
  walletPage: false;
  rewards: true;
  practiceOpen: false;
  signedIn: boolean;
  ready: boolean;
  busy: boolean;
  canSignIn: boolean;
  accountSeed?: string;
}

/** Story-only session/community client boundary for the production shell. */
export function createCommunityShellStoryClient(initial: CommunityShellStoryState) {
  const [snapshot, setSnapshot] = createSignal(initial, { ownedWrite: true });
  return {
    snapshot,
    async signIn() {
      setSnapshot((current) => ({ ...current, busy: true }));
      await Promise.resolve();
      setSnapshot((current) => ({
        ...current,
        signedIn: true,
        busy: false,
        accountSeed: "catalog-account",
      }));
    },
  };
}
