// Offline test-only transport. Mounts actual client/integration/source profile.
// Buttons below are harness controls, never a product metadata editor.
import { createSignal } from "solid-js";
import { createProfileClient } from "../src/shell/profiles/client.ts";
import { createCommunityProfileIntegration } from "../src/shell/profiles/integration.ts";
import { CommunityProfilePage } from "../src/shell/profiles/pages.tsx";
import type {
  OwnerProfile,
  ProfileMutation,
  ProfileMutationReceipt,
} from "../../../packages/community-profile/contracts.ts";

export function ProfileRecoveryInput(props: {
  failureAt: "owner" | "receipt";
  status: number;
  body: string;
}) {
  const communityId = "0x" + "1".repeat(64),
    authorId = "0x" + "2".repeat(64);
  const owner: OwnerProfile = {
    schema: "pirate.community-profile-owner/1",
    communityId,
    accountId: "private-fixture-account",
    profile: {
      schema: "pirate.community-profile/1",
      communityId,
      authorId,
      revision: 0,
      displayName: null,
      bio: null,
      avatarRef: null,
      coverRef: null,
    },
    capabilities: { metadata: true, publicMedia: false, handles: false },
  };
  const [saves, setSaves] = createSignal(0),
    [blocked, setBlocked] = createSignal(false);
  const [receiptReads, setReceiptReads] = createSignal(0);
  let committed: ProfileMutationReceipt | null = null;
  let ownerFails = false,
    recovered = false;
  const client = createProfileClient(communityId, (async (url, init) => {
    if (init?.method === "PUT") {
      setSaves((count) => count + 1);
      const command = JSON.parse(String(init.body)) as ProfileMutation;
      committed = {
        schema: "pirate.community-profile-mutation/1",
        mutationId: command.mutationId,
        profile: {
          ...owner.profile,
          revision: 1,
          displayName: command.displayName,
        },
      };
      throw new TypeError("fixture committed; ACK lost");
    }
    if (String(url).includes("/mutations/")) {
      setReceiptReads((count) => count + 1);
      if (committed && !recovered)
        return new Response(props.body, { status: props.status });
      return Response.json({
        schema: "pirate.community-profile-receipt-read/1",
        receipt: committed,
      });
    }
    if (String(url) === "/api/profile/owner") {
      if (ownerFails) return new Response(props.body, { status: props.status });
      return Response.json(owner);
    }
    if (String(url).includes("/activity?"))
      return Response.json({
        schema: "pirate.community-profile-activity/1",
        communityId,
        authorId,
        profile: owner.profile,
        items: [],
        nextCursor: null,
        window: "current-public-catalogue",
      });
    throw new Error("fixture has no other service");
  }) as typeof fetch);
  const integration = createCommunityProfileIntegration({
    communityId: () => communityId,
    identity: () => ({ authorId, csrf: "fixture", scopeKey: "fixture" }),
    ready: () => true,
    client: () => client,
  });
  const fields = {
    displayName: "Fixture profile",
    bio: null,
    avatarRef: null,
    coverRef: null,
  };
  return (
    <div
      data-profile-recovery
      data-view={integration.state().view.kind}
      data-owner-present={
        integration.ownerAccountId() !== undefined ? "true" : "false"
      }
      data-mutation={integration.state().mutation}
      data-saves={saves()}
      data-receipt-reads={receiptReads()}
      data-second-save-blocked={blocked() ? "true" : "false"}
    >
      <button onClick={() => void integration.controller()?.save(fields)}>
        Fixture save
      </button>
      <button onClick={() => void integration.controller()?.retry()}>
        Fixture retry receipt
      </button>
      <button
        onClick={() => {
          void integration
            .controller()
            ?.save(fields)
            .catch(() => setBlocked(true));
        }}
      >
        Fixture attempt new save
      </button>
      <button
        onClick={() => {
          ownerFails = props.failureAt === "owner";
          void integration.controller()?.load();
        }}
      >
        Fixture lose owner authority
      </button>
      <button
        onClick={() => {
          recovered = true;
          ownerFails = false;
          void (async () => {
            await integration.controller()?.load();
            await integration.controller()?.retry();
          })();
        }}
      >
        Fixture restore authority
      </button>
      <CommunityProfilePage
        communityId={communityId}
        authorityKey="fixture"
        integration={integration}
        navigate={() => {}}
        signIn={async () => {}}
        logout={async () => {}}
        canSignIn
        canSignOut
        walletAvailable
      />
    </div>
  );
}
