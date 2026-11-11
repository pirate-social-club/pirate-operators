import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Avatar, Button, Card, CardContent, Type } from "../design-system.ts";
import type { CommunityAccountProps } from "./pages.tsx";
const publicHref = (id: string) => "/#profile-" + id;
/** Exact AccountPage frame/action lifecycle @ c7; services are actual host ports. */
export function CommunityAccountSettings(
  props: CommunityAccountProps & { profile?: boolean },
) {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  const [pendingAction, setPendingAction] = createSignal("");
  let generation = 0,
    active = true;
  createEffect(
    () => props.integration.authorityKey(),
    () => {
      generation++;
      setPending(false);
      setPendingAction("");
      setError("");
    },
  );
  onCleanup(() => {
    active = false;
    generation++;
  });
  const owner = () => {
    const view = props.integration.state().view;
    return view.kind === "ready" ? view.owner : undefined;
  };
  const run = async (
    operation: () => Promise<void>,
    failure: string,
    action = "",
  ) => {
    if (pending()) return;
    const current = generation;
    setPending(true);
    setPendingAction(action);
    setError("");
    try {
      await operation();
    } catch {
      if (active && current === generation) setError(failure);
    } finally {
      if (active && current === generation) {
        setPending(false);
        setPendingAction("");
      }
    }
  };
  return (
    <main
      class="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8"
      data-route-path={props.profile ? "/me" : "/settings"}
    >
      <Type as="h1" variant="h1">
        {props.profile ? "Profile" : "Settings"}
      </Type>
      <Card>
        <CardContent class="flex flex-col gap-4 p-5">
          <Show
            when={owner()}
            fallback={
              <>
                <Type>
                  {props.integration.state().view.kind === "anonymous"
                    ? "Sign in to manage your profiles."
                    : props.integration.state().view.kind === "unavailable"
                      ? "Your account could not be checked."
                      : "Checking your account…"}
                </Type>
                <Show
                  when={
                    props.integration.state().view.kind === "anonymous" &&
                    props.canSignIn
                  }
                >
                  <Button
                    class="self-start"
                    disabled={pending()}
                    onClick={() =>
                      void run(props.signIn, "Sign in could not be completed.")
                    }
                  >
                    Sign in
                  </Button>
                </Show>
                <Show
                  when={props.integration.state().view.kind === "unavailable"}
                >
                  <Button
                    class="self-start"
                    variant="outline"
                    onClick={() => void props.integration.controller()?.load()}
                  >
                    Check again
                  </Button>
                </Show>
                <Show
                  when={
                    props.canSignOut &&
                    props.integration.state().view.kind !== "anonymous"
                  }
                >
                  <Button
                    class="self-start"
                    variant="ghost"
                    disabled={pending()}
                    onClick={() =>
                      void run(
                        props.logout,
                        "Sign out failed. Please try again.",
                        "sign-out",
                      )
                    }
                  >
                    {pending() && pendingAction() === "sign-out"
                      ? "Signing out…"
                      : "Sign out"}
                  </Button>
                </Show>
              </>
            }
          >
            {(value) => (
              <>
                <div class="flex items-center gap-3">
                  <Avatar
                    fallback={value().profile.displayName ?? "Profile"}
                    src={value().profile.avatarRef ?? undefined}
                    fallbackSeed={value().profile.displayName ?? "Profile"}
                  />
                  <div class="min-w-0">
                    <Type as="p" variant="body-strong">
                      {value().profile.displayName ?? "Profile"}
                    </Type>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      props.navigate(publicHref(value().profile.authorId))
                    }
                  >
                    View profile
                  </Button>
                  <Show when={props.walletAvailable}>
                    <Button
                      variant="outline"
                      onClick={() => props.navigate("/wallet")}
                    >
                      Wallet
                    </Button>
                  </Show>
                  {props.services?.telegram?.()}
                </div>
                <Show when={props.services?.privateHistory}>
                  <Button
                    class="self-start"
                    variant="outline"
                    disabled={pending()}
                    onClick={() =>
                      void run(
                        props.services!.privateHistory!,
                        "Private history could not be downloaded. Try again.",
                      )
                    }
                  >
                    Download private history
                  </Button>
                </Show>
                {props.services?.publicResults?.()}
                <Button
                  class="self-start"
                  variant="ghost"
                  disabled={pending()}
                  onClick={() =>
                    void run(
                      props.logout,
                      "Sign out failed. Please try again.",
                      "sign-out",
                    )
                  }
                >
                  {pending() && pendingAction() === "sign-out"
                    ? "Signing out…"
                    : "Sign out"}
                </Button>
              </>
            )}
          </Show>

          <Show when={error()}>
            <Type role="alert">{error()}</Type>
          </Show>
        </CardContent>
      </Card>
      <Show when={owner() && props.services?.recordings}>
        <Card>
          <CardContent class="p-5">
            {props.services?.recordings?.()}
          </CardContent>
        </Card>
      </Show>
      <div class="flex gap-4">
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </div>
    </main>
  );
}
