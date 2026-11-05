// Client entry: mounts into the empty shell and action roots of a generated
// document, and owns #public-content only after the reader navigates.
import { Button } from "../ui.ts";
import { render } from "@solidjs/web";
import { createSignal, Show, type Accessor } from "solid-js";
import { CommunityContent, NotFoundContent, PostContent, RemovedContent, type ContentLabels } from "../document/content.tsx";
import { catalogFor, message, type MessageKey } from "../locale.ts";
import { paths, PROTOCOL_VERSION, type CommunityConfig } from "../model.ts";
import {
  canonicalHref,
  createDataSource,
  matchRoute,
  readSession,
  recordKey,
  resolveMode,
  sameView,
  viewFor,
  type Mode,
  type SessionState,
  type View,
} from "./navigation.ts";
import "../styles/client.css";

const catalog = catalogFor(document.documentElement.lang);
const t = (key: MessageKey, values?: Record<string, string>) => message(catalog, key, values);
const labels: ContentLabels = { posts: t("posts"), by: t("by"), song: t("song"), published: t("published"), fixture: t("fixture") };

function Shell(props: {
  readonly config: CommunityConfig;
  readonly mode: Mode;
  readonly communityName: Accessor<string>;
  readonly session: Accessor<SessionState>;
  readonly path: Accessor<string>;
}) {
  const host = new URL(props.config.canonicalOrigin).host;
  return (
    <header class="border-b border-border-soft" data-mode={props.mode}>
      <Show when={props.mode === "mirror"}>
        <p class="bg-muted px-4 py-2 text-center text-sm" data-mirror-notice="true">{t("mirrorNotice", { host })}</p>
      </Show>
      <nav class="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-4 px-4 py-3">
        <a class="font-semibold" href={paths.page.community}>{props.communityName() || t("home")}</a>
        <a class="text-muted-foreground hover:text-foreground" href="/about">{t("about")}</a>
        <Show when={props.config.fixture === true}>
          <span class="text-sm text-muted-foreground" data-fixture="true">{t("fixture")}</span>
        </Show>
        <span class="ms-auto flex items-center gap-3">
          <Show
            when={props.mode === "canonical"}
            fallback={<a class="text-primary-text underline-offset-4 hover:underline" data-action="sign-in" href={canonicalHref(props.config, props.path())}>{t("signInOn", { host })}</a>}
          >
            <span class="text-sm text-muted-foreground" data-session={props.session()}>
              {props.session() === "unavailable" ? t("sessionUnavailable") : props.session() === "signed-out" ? t("signedOut") : ""}
            </span>
            <Button size="sm" variant="outline" disabled title={t("signInPending")} data-action="sign-in">{t("signIn")}</Button>
          </Show>
        </span>
      </nav>
    </header>
  );
}

function PostActions(props: { readonly config: CommunityConfig; readonly mode: Mode; readonly slug: Accessor<string | null> }) {
  const host = new URL(props.config.canonicalOrigin).host;
  return (
    <Show when={props.slug()}>
      {slug => (
        <div class="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 pb-8">
          <Show
            when={props.mode === "canonical"}
            fallback={<a class="text-primary-text underline-offset-4 hover:underline" data-action="reply" href={canonicalHref(props.config, paths.page.post(slug()))}>{t("replyOn", { host })}</a>}
          >
            <Button variant="secondary" disabled title={t("signInPending")} data-action="reply">{t("reply")}</Button>
            <span class="text-sm text-muted-foreground">{t("signInPending")}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}

function RouteView(props: { readonly view: Accessor<View> }) {
  const view = () => props.view();
  return (
    <>
      {(() => {
        const current = view();
        switch (current.kind) {
          case "loading":
            return <p class="sr-only" aria-live="polite">…</p>;
          case "community":
            return <CommunityContent community={current.community} labels={labels} />;
          case "post":
            return (
              <>
                <Show when={current.updated}>
                  <p class="mx-auto mt-4 max-w-2xl px-4 text-sm text-muted-foreground" data-notice="updated">{t("updated")}</p>
                </Show>
                <PostContent post={current.post} labels={labels} />
              </>
            );
          case "about":
            return (
              <section class="mx-auto w-full max-w-2xl px-4 py-8" data-content="about">
                <h1 class="text-2xl font-semibold">{t("aboutTitle")}</h1>
                <p class="mt-2 text-muted-foreground" lang={current.community?.lang} dir={current.community?.dir}>{current.community?.description ?? ""}</p>
              </section>
            );
          case "removed":
            return <RemovedContent message={t("removed")} homeLabel={t("backHome")} />;
          case "unavailable":
            return (
              <section class="mx-auto w-full max-w-2xl px-4 py-8" data-content="unavailable">
                <p>{t("unavailable")}</p>
                <a class="mt-4 inline-block underline-offset-4 hover:underline" href={paths.page.community}>{t("backHome")}</a>
              </section>
            );
          case "not-found":
            return <NotFoundContent message={t("notFound")} homeLabel={t("backHome")} />;
        }
      })()}
    </>
  );
}

async function readConfig(): Promise<CommunityConfig | null> {
  try {
    const response = await fetch(paths.config, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const config = await response.json() as CommunityConfig;
    return config.protocolVersions.includes(PROTOCOL_VERSION) ? config : null;
  } catch {
    return null;
  }
}

async function main() {
  const shellRoot = document.getElementById("app-shell-root");
  const actionsRoot = document.getElementById("app-actions-root");
  const content = document.getElementById("public-content");
  if (shellRoot === null || actionsRoot === null || content === null) return;
  const config = await readConfig();
  // Without a compatible configuration the published content stays readable
  // and the client mounts nothing else.
  if (config === null) return;
  const mode = resolveMode(location.origin, config);
  const source = createDataSource(mode);
  const records = source.records;
  const entryPage = document.body.dataset.page;
  const [path, setPath] = createSignal(location.pathname);
  const [view, setView] = createSignal<View>({ kind: "loading" });
  const [communityName, setCommunityName] = createSignal("");
  const [session, setSession] = createSignal<SessionState>("checking");
  const entrySlug = entryPage === "post" ? content.dataset.slug ?? null : null;
  const [actionSlug, setActionSlug] = createSignal<string | null>(entrySlug);
  records.subscribe(key => {
    if (key === recordKey.community) setCommunityName(records.community()?.name ?? "");
  });

  render(() => <Shell config={config} mode={mode} communityName={communityName} session={session} path={path} />, shellRoot);
  render(() => <PostActions config={config} mode={mode} slug={actionSlug} />, actionsRoot);
  if (mode === "canonical") void readSession(fetch.bind(globalThis)).then(setSession);

  let owned = false;
  const takeOver = () => {
    if (owned) return;
    owned = true;
    content.replaceChildren();
    delete content.dataset.revision;
    render(() => <RouteView view={view} />, content);
  };

  let generation = 0;
  let inflight: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  /**
   * Show a route. Stored records render at once, and the view follows every
   * later change to its record, whichever read delivers it. All sources then
   * refresh in parallel, bounded and aborted when superseded. For the
   * generated entry page, `published` is the page's revision: the client takes
   * over only for a strictly newer record or an authoritative 404.
   */
  const show = async (pathname: string, published?: number) => {
    inflight?.abort();
    unsubscribe?.();
    const controller = new AbortController();
    inflight = controller;
    const issued = ++generation;
    const route = matchRoute(pathname);
    setPath(pathname);
    const key = route.kind === "post" ? recordKey.post(route.slug)
      : route.kind === "community" || route.kind === "about" ? recordKey.community
      : undefined;
    const apply = (next: View) => {
      if (issued !== generation) return;
      // An unchanged view keeps its DOM, so focus and selection survive.
      if (owned && sameView(view(), next)) return;
      takeOver();
      setView(next);
      setActionSlug(next.kind === "post" ? next.post.slug : null);
    };
    const update = () => {
      if (published === undefined) return apply(viewFor(route, records, false) ?? { kind: "loading" });
      if (key === undefined) return;
      if (records.isMissing(key)) return apply({ kind: "not-found" });
      const held = route.kind === "post" ? records.post(route.slug) : records.community();
      if (held !== undefined && held.revision > published) apply(viewFor(route, records, true) ?? { kind: "unavailable" });
    };
    if (key !== undefined) unsubscribe = records.subscribe(changed => { if (changed === key) update(); });
    update();
    if (key === undefined) return;

    const status = route.kind === "post"
      ? await source.refreshPost(route.slug, controller.signal)
      : await source.refreshCommunity(controller.signal);
    if (issued !== generation) return;
    if (status === "unavailable" && published === undefined && viewFor(route, records, false) === undefined) {
      apply({ kind: "unavailable" });
    }
  };

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== "" || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || matchRoute(url.pathname).kind === "not-found") return;
    event.preventDefault();
    if (url.pathname === location.pathname) return;
    history.pushState(null, "", url.pathname);
    void show(url.pathname);
  });
  window.addEventListener("popstate", () => void show(location.pathname));

  // The header needs the community on every page; a community route reads it
  // itself, so only other pages start a separate, unaborted read.
  const entryRoute = matchRoute(location.pathname);
  if (entryRoute.kind !== "community" && entryRoute.kind !== "about") {
    void source.refreshCommunity(new AbortController().signal);
  }

  if (entryPage === "shell") {
    void show(location.pathname);
  } else if (entryPage === "post" || entryPage === "community") {
    // A generated page may be older than the current record: reconcile it.
    void show(location.pathname, Number(content.dataset.revision));
  }
}

void main();
