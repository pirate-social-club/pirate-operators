// Publication-time HTML for document version 1.
//
// This stands in for the community publisher in contract section 3: it renders
// the presentational components to strings and writes one document per public
// page, a tombstone target, the snapshot data a mirror needs, and the
// community configuration copy. It is run once per build over fixture data; it
// is not the idempotent job system (contract rows P2 and P5 are not claimed).
import { NoHydration, renderToString } from "@solidjs/web";
import { createHash } from "node:crypto";
import { CommunityContent, NotFoundContent, PostContent, RemovedContent, type ContentLabels } from "../document/content.tsx";
import { catalogFor, directionOf, localeBootScript } from "../locale.ts";
import {
  DOCUMENT_VERSION,
  isSlug,
  paths,
  type CommunityConfig,
  type PostRecord,
  type PublicCommunity,
  type PublicPost,
} from "../model.ts";

export interface PublishInput {
  readonly config: CommunityConfig;
  readonly community: PublicCommunity;
  readonly posts: readonly PostRecord[];
  readonly generatedAt: string;
}

export interface PublishedFile {
  readonly path: string;
  readonly body: string;
}

export interface PublishResult {
  readonly files: readonly PublishedFile[];
  readonly bootScriptSha256: string;
  readonly mirrorPolicy: string;
  readonly livePostSlugs: readonly string[];
  readonly removedPostSlugs: readonly string[];
}

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;");

/** The policy every generated document carries in a meta element. */
export function mirrorContentSecurityPolicy(bootScriptSha256: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${bootScriptSha256}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
}

interface Frame {
  readonly config: CommunityConfig;
  readonly siteName: string;
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly page: "community" | "post" | "shell" | "not-found" | "removed";
  readonly content: string;
  readonly revision?: number;
  readonly slug?: string;
  readonly generatedAt: string;
  readonly bootScript: string;
  readonly policy: string;
  readonly ogType?: "website" | "article";
  readonly indexable: boolean;
  readonly noscript?: string;
}

function documentHtml(frame: Frame): string {
  const language = frame.config.defaultLanguage;
  const canonical = `${frame.config.canonicalOrigin}${frame.path}`;
  const share = frame.indexable
    ? [
        `<link rel="canonical" href="${escapeAttribute(canonical)}">`,
        `<meta property="og:site_name" content="${escapeAttribute(frame.siteName)}">`,
        `<meta property="og:title" content="${escapeAttribute(frame.title)}">`,
        `<meta property="og:description" content="${escapeAttribute(frame.description)}">`,
        `<meta property="og:type" content="${frame.ogType ?? "website"}">`,
        `<meta property="og:url" content="${escapeAttribute(canonical)}">`,
        `<meta name="twitter:card" content="summary">`,
      ]
    : [`<meta name="robots" content="noindex">`];
  const mainAttributes = [
    `id="public-content"`,
    frame.revision === undefined ? "" : `data-revision="${frame.revision}"`,
    frame.slug === undefined ? "" : `data-slug="${escapeAttribute(frame.slug)}"`,
    `data-generated-at="${escapeAttribute(frame.generatedAt)}"`,
  ].filter(Boolean).join(" ");
  return [
    "<!doctype html>",
    `<html lang="${escapeAttribute(language)}" dir="${directionOf(language)}" data-document-version="${DOCUMENT_VERSION}">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frame.policy)}">`,
    `<title>${escapeText(frame.title)}</title>`,
    `<meta name="description" content="${escapeAttribute(frame.description)}">`,
    ...share,
    `<link rel="stylesheet" href="${paths.documentStylesheet(DOCUMENT_VERSION)}">`,
    `<script>${frame.bootScript}</script>`,
    `<script type="module" src="${paths.boot}"></script>`,
    "</head>",
    `<body data-page="${frame.page}">`,
    `<div id="app-shell-root"></div>`,
    `<main ${mainAttributes}>${frame.content}${frame.noscript === undefined ? "" : `<noscript><p class="mx-auto max-w-2xl px-4 py-8">${escapeText(frame.noscript)}</p></noscript>`}</main>`,
    `<div id="app-actions-root"></div>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Static markup: no hydration keys and no serialized data scripts. */
const staticMarkup = (render: () => unknown) =>
  renderToString(() => <NoHydration>{render() as never}</NoHydration>, { noScripts: true });

export function publish(input: PublishInput): PublishResult {
  const { config, community, generatedAt } = input;
  const catalog = catalogFor(config.defaultLanguage);
  const labels: ContentLabels = {
    posts: catalog.posts,
    by: catalog.by,
    song: catalog.song,
    published: catalog.published,
    fixture: catalog.fixture,
  };
  const bootScript = localeBootScript(config.defaultLanguage, config.supportedLanguages);
  const bootScriptSha256 = createHash("sha256").update(bootScript).digest("base64");
  const policy = mirrorContentSecurityPolicy(bootScriptSha256);
  const frame = { config, siteName: community.name, generatedAt, bootScript, policy };
  const files: PublishedFile[] = [];
  const live: PublicPost[] = [];
  const removed: string[] = [];

  for (const record of input.posts) {
    if (!isSlug(record.slug)) throw new Error(`invalid post slug: ${record.slug}`);
    if (record.kind === "removed") removed.push(record.slug);
    else live.push(record);
    // The snapshot record of a removal is itself a tombstone without content.
    files.push({ path: paths.snapshot.post(record.slug), body: json(record) });
  }

  files.push({
    path: "/index.html",
    body: documentHtml({
      ...frame,
      title: community.name,
      description: community.description,
      path: paths.page.community,
      page: "community",
      revision: community.revision,
      content: staticMarkup(() => <CommunityContent community={community} labels={labels} />),
      indexable: true,
    }),
  });

  for (const post of live) {
    files.push({
      path: `${paths.page.post(post.slug)}index.html`,
      body: documentHtml({
        ...frame,
        title: post.title,
        description: post.body.slice(0, 200),
        path: paths.page.post(post.slug),
        page: "post",
        revision: post.revision,
        slug: post.slug,
        content: staticMarkup(() => <PostContent post={post} labels={labels} />),
        ogType: "article",
        indexable: true,
      }),
    });
  }

  files.push({
    path: paths.gone,
    body: documentHtml({
      ...frame,
      title: catalog.removed,
      description: catalog.removed,
      path: paths.gone,
      page: "removed",
      content: staticMarkup(() => <RemovedContent message={catalog.removed} homeLabel={catalog.backHome} />),
      indexable: false,
    }),
  });
  files.push({
    path: paths.notFound,
    body: documentHtml({
      ...frame,
      title: catalog.notFound,
      description: catalog.notFound,
      path: paths.notFound,
      page: "not-found",
      content: staticMarkup(() => <NotFoundContent message={catalog.notFound} homeLabel={catalog.backHome} />),
      indexable: false,
    }),
  });
  files.push({
    path: paths.shell,
    body: documentHtml({
      ...frame,
      title: community.name,
      description: community.description,
      path: paths.shell,
      page: "shell",
      content: "",
      indexable: false,
      noscript: catalog.noscript,
    }),
  });

  files.push({ path: paths.snapshot.community, body: json(community) });
  files.push({ path: paths.config, body: json(config) });

  return {
    files,
    bootScriptSha256,
    mirrorPolicy: policy,
    livePostSlugs: live.map(post => post.slug),
    removedPostSlugs: removed,
  };
}
