import {
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
} from "solid-js";
import {
  communityAuthorityKey,
  createCommunityComposerRuntime,
  type CommunityComposerRuntime,
  type CommunityRuntimeOptions,
} from "./community-composer-runtime.ts";

/** Application construction only; never call from a prop getter or renderer. */
export function createCommunityComposerScope(options: CommunityRuntimeOptions) {
  if (!getOwner())
    throw new Error(
      "Construct the composer scope under the application Solid owner.",
    );
  const scope = createRoot((disposeRoot) => {
    const applicationOwner = getOwner()!;
    const [saved, setSaved] = createSignal<CommunityComposerRuntime | null>(
      null,
      { ownedWrite: true },
    );
    let disposed = false,
      blockedAuthority: string | null = null;
    let currentRuntime: CommunityComposerRuntime | null = null;
    const runtime = () => {
      saved(); // Reactive notification; the custody pointer itself is immediate.
      const current = currentRuntime;
      return !disposed && current?.active() ? current : null;
    };
    const invalidate = () => {
      blockedAuthority = communityAuthorityKey(options.current());
      currentRuntime?.invalidate();
    };
    createEffect(
      () => communityAuthorityKey(options.current()),
      (key) => {
        const previous = currentRuntime;
        if (previous?.authority === key) return;
        previous?.dispose();
        currentRuntime = null;
        setSaved(null);
        if (!disposed && key && key !== blockedAuthority) {
          // Solid 2 apply callbacks are not component construction scopes.
          const next = runWithOwner(applicationOwner, () =>
            createCommunityComposerRuntime(options),
          );
          currentRuntime = next;
          setSaved(next);
        }
      },
    );
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      currentRuntime?.dispose();
      currentRuntime = null;
      disposeRoot();
    };
    onCleanup(() => {
      disposed = true;
      currentRuntime?.dispose();
      currentRuntime = null;
    });
    return {
      runtime,
      status: () =>
        runtime()?.fault() ??
        (saved()?.active()
          ? null
          : "Reconnect your private community profile before opening the composer."),
      items: () => runtime()?.items() ?? [],
      count: () => runtime()?.items().length ?? 0,
      viewClosed: () => saved()?.viewClosed(),
      openStatus: (id: string) => runtime()?.openStatus(id) ?? false,
      check: (id: string) => runtime()?.check(id),
      retry: (id: string) => runtime()?.retry(id),
      dismiss: (id: string) => runtime()?.dismiss(id),
      invalidate,
      dispose,
    };
  });
  onCleanup(scope.dispose);
  return scope;
}
export type CommunityComposerScope = ReturnType<
  typeof createCommunityComposerScope
>;
