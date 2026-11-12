// UNRUN integration case for immutable W1 6ad, where real profile source exists.
// Apply at apps/web/test/media-community-shell-profile.browser.tsx, after source
// join. Native storage and real profile/client/controller/scope/components;
// cookie/service replies are explicit protocol simulations, never providers.
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { createCommunityProfileIntegration } from "../src/shell/profiles/integration.ts";
import { createProfileClient } from "../src/shell/profiles/client.ts";
import {
  createCommunityComposerScope,
  type CommunityComposerScope,
} from "../src/media/community-composer-scope.ts";
import {
  CommunityComposerHost,
  CommunityPendingSongs,
} from "../src/media/community-host.tsx";
import { captureCommunityOwner } from "../src/media/community-contracts.ts";
import {
  CommunitySongController,
  createBrowserSongStorage,
} from "../src/media/community-song-controller.ts";
import { communityHttp } from "../src/media/community-http.ts";
import { shellFixture } from "./media-community-shell-fixture.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(condition: () => boolean) {
  const end = performance.now() + 6000;
  while (!condition()) {
    if (performance.now() > end)
      throw new Error("Profile join fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function runCommunityShellProfileBrowserCase(root: HTMLElement) {
  const f = shellFixture(location.origin),
    seedOwner = captureCommunityOwner(() => f.context),
    storage = createBrowserSongStorage(seedOwner);
  const seed = new CommunitySongController({
    owner: seedOwner,
    store: storage,
    http: communityHttp(seedOwner, f.transport),
  });
  await seed.prepare(f.input);
  await seed.publish();
  seedOwner.dispose();
  let refuse = false,
    profileCalls = 0,
    bodyReads = 0,
    opened: string | undefined;
  const [route, setRoute] = createSignal("publish", { ownedWrite: true });
  let integration!: ReturnType<typeof createCommunityProfileIntegration>,
    scope!: CommunityComposerScope;
  const profileFetch: typeof fetch = async (path) => {
    check(
      String(path) === "/api/profile/owner",
      "invented private profile endpoint",
    );
    profileCalls++;
    if (refuse) {
      const response = new Response(null, { status: 403 });
      response.json = async () => {
        bodyReads++;
        return new Promise(() => {});
      };
      return response;
    }
    return Response.json({
      schema: "pirate.community-profile-owner/1",
      communityId: f.context.community.id,
      accountId: f.context.owner.accountId,
      profile: {
        schema: "pirate.community-profile/1",
        communityId: f.context.community.id,
        authorId: f.context.session.authorId,
        revision: 1,
        displayName: "Fixture",
        bio: null,
        avatarRef: null,
        coverRef: null,
      },
      capabilities: { metadata: true, handles: false, publicMedia: false },
    });
  };
  const dispose = render(() => {
    integration = createCommunityProfileIntegration({
      communityId: () => f.context.community.id,
      identity: () => ({
        authorId: f.context.session.authorId,
        csrf: f.context.session.csrf,
        scopeKey: f.context.session.csrf,
      }),
      ready: () => true,
      client: (id) => createProfileClient(id, profileFetch),
    });
    let known = "",
      generation = "";
    scope = createCommunityComposerScope({
      current: () => {
        const accountId = integration.ownerAccountId();
        if (!accountId) {
          known = "";
          return null;
        }
        const key = JSON.stringify([
          f.context.community.id,
          accountId,
          f.context.session.authorId,
          f.context.session.csrf,
        ]);
        if (key !== known) {
          known = key;
          generation = crypto.randomUUID();
        }
        return {
          ...f.context,
          owner: {
            accountId,
            communityId: f.context.community.id,
            authorId: f.context.session.authorId,
            generation,
          },
        };
      },
      refreshFeed: async () => {},
      transport: f.transport,
      observeIntervalMs: 20,
    });
    return (
      <>
        <Show when={route() === "publish"}>
          <CommunityComposerHost
            scope={scope}
            open
            onOpenChange={(open) => {
              if (!open) setRoute("home");
            }}
          />
        </Show>
        <Show when={route() === "home"}>
          <CommunityPendingSongs
            scope={scope}
            onOpenStatus={(id) => {
              opened = id;
              setRoute("publish");
            }}
          />
        </Show>
      </>
    );
  }, root);
  try {
    await until(() => scope.count() === 1);
    check(
      profileCalls > 0 &&
        integration.ownerAccountId() === f.context.owner.accountId,
      "default producer did not supply private account",
    );
    check(
      scope.runtime()?.owner.accountId !== f.context.session.authorId &&
        scope.runtime()?.owner.accountId !== f.context.session.mossAddress,
      "private authority replaced by public/wallet identity",
    );
    check(
      !scope.openStatus(crypto.randomUUID()),
      "foreign status identity accepted",
    );
    setRoute("home");
    await until(
      () =>
        !!root.querySelector(
          `[data-pending-song-open-status="${f.submissionId}"]`,
        ),
    );
    root
      .querySelector<HTMLButtonElement>(
        `[data-pending-song-open-status="${f.submissionId}"]`,
      )!
      .click();
    await until(
      () =>
        opened === f.submissionId &&
        !!root.querySelector('[aria-label="Close song status"]'),
    );
    refuse = true;
    const old = scope.runtime();
    await integration.controller()!.load();
    await until(
      () => integration.ownerAccountId() === undefined && scope.count() === 0,
    );
    check(
      bodyReads === 0 && !old?.active(),
      "private 403 waited for body or retained old owner",
    );
    check(
      f.calls.filter((call) => call.method !== "GET").length === 7,
      "profile/status routing replayed native publication",
    );
    return {
      cases: [
        "actual default private profile producer",
        "original PendingSongs Status routing",
        "foreign status denial",
        "private profile 403 header masks scope before body; no replay",
      ],
      execution: "simulation with actual native browser required",
    };
  } finally {
    dispose();
    const owner = captureCommunityOwner(() => f.context),
      cleanup = createBrowserSongStorage(owner);
    await cleanup.exclusive(async () => {
      await cleanup.load();
      await cleanup.remove();
    });
    owner.dispose();
  }
}
