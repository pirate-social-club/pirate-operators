// Presentational public content, document version 1.
//
// These components are the source of the markup and classes for generated
// pages (rendered to strings at publication time) and for the client's own
// views after navigation. They take content and messages as props only: no
// context, fetching or browser globals. Classes used here are frozen into
// /public/document-v1.css, so changing them needs a new document version.
import { Card, CardContent, CardHeader, Type } from "../ui.ts";
import { For, Show } from "solid-js";
import type { PostSummary, PublicCommunity, PublicPost } from "../model.ts";
import { paths } from "../model.ts";

export interface ContentLabels {
  readonly posts: string;
  readonly by: string;
  readonly song: string;
  readonly published: string;
  readonly fixture: string;
}

function FixtureMark(props: { readonly show: boolean; readonly label: string }) {
  return (
    <Show when={props.show}>
      <p class="mb-4 inline-block rounded-[var(--radius-sm)] border border-border-soft px-2 py-0.5 text-sm text-muted-foreground" data-fixture="true">
        {props.label}
      </p>
    </Show>
  );
}

function PostLink(props: { readonly post: PostSummary; readonly labels: ContentLabels }) {
  return (
    <li>
      <a class="block rounded-[var(--radius-lg)] border border-border-soft bg-card p-4 hover:bg-card-hover" href={paths.page.post(props.post.slug)}>
        <Type as="span" variant="body-strong" class="block">{props.post.title}</Type>
        <Type as="span" variant="caption" class="block">
          {props.labels.by} <bdi>@{props.post.author.handle}</bdi>
        </Type>
      </a>
    </li>
  );
}

export function CommunityContent(props: { readonly community: PublicCommunity; readonly labels: ContentLabels }) {
  return (
    <section class="mx-auto w-full max-w-2xl px-4 py-8" lang={props.community.lang} dir={props.community.dir} data-content="community">
      <FixtureMark show={props.community.fixture === true} label={props.labels.fixture} />
      <Type as="h1" variant="h1">{props.community.name}</Type>
      <Type as="p" variant="caption" class="mt-2">{props.community.description}</Type>
      <Type as="h2" variant="h3" class="mt-8 mb-3">{props.labels.posts}</Type>
      <ul class="flex flex-col gap-3">
        <For each={props.community.posts}>{post => <PostLink post={post} labels={props.labels} />}</For>
      </ul>
    </section>
  );
}

export function PostContent(props: { readonly post: PublicPost; readonly labels: ContentLabels }) {
  return (
    <article class="mx-auto w-full max-w-2xl px-4 py-8" lang={props.post.lang} dir={props.post.dir} data-content="post" data-slug={props.post.slug}>
      <FixtureMark show={props.post.fixture === true} label={props.labels.fixture} />
      <Card>
        <CardHeader>
          {/* CardTitle allows h2-h6; the post title is the page's h1, with CardTitle's classes. */}
          <Type as="h1" variant="h3" class="text-balance">{props.post.title}</Type>
          <Type as="p" variant="caption">
            {props.labels.by} <bdi>@{props.post.author.handle}</bdi>
            {" · "}
            <time datetime={props.post.publishedAt}>{props.post.publishedAt.slice(0, 10)}</time>
          </Type>
        </CardHeader>
        <CardContent>
          <Show when={props.post.song}>
            {song => (
              <Type as="p" variant="label" class="mb-3">
                {props.labels.song}: <bdi>{song().title}</bdi> · <bdi>{song().artist}</bdi>
              </Type>
            )}
          </Show>
          <Type as="p" variant="body">{props.post.body}</Type>
        </CardContent>
      </Card>
    </article>
  );
}

/** A tombstone carries none of the removed content or metadata. */
export function RemovedContent(props: { readonly message: string; readonly homeLabel: string }) {
  return (
    <section class="mx-auto w-full max-w-2xl px-4 py-8" data-content="removed">
      <Type as="h1" variant="h2">{props.message}</Type>
      <a class="mt-4 inline-block text-primary-text underline-offset-4 hover:underline" href={paths.page.community}>{props.homeLabel}</a>
    </section>
  );
}

export function NotFoundContent(props: { readonly message: string; readonly homeLabel: string }) {
  return (
    <section class="mx-auto w-full max-w-2xl px-4 py-8" data-content="not-found">
      <Type as="h1" variant="h2">{props.message}</Type>
      <a class="mt-4 inline-block text-primary-text underline-offset-4 hover:underline" href={paths.page.community}>{props.homeLabel}</a>
    </section>
  );
}
