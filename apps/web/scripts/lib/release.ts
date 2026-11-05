// Pure release helpers: redirects, host headers, boot loader, manifests and
// the initial JavaScript budget. Unit tested in test/release.test.ts.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const gzipBytes = (bytes: Uint8Array | string) => gzipSync(bytes, { level: 9 }).byteLength;

/** Initial JavaScript budget from contract section 5, in gzip bytes. */
export const INITIAL_JS_BUDGET_BYTES = 100_000;

/**
 * IPFS gateways evaluate `_redirects` only for paths with no file, first
 * match wins. Live posts and the community page are files. A removed post
 * gets a real 410 pointing at a content-free tombstone; any other post path
 * and any unknown path gets a real 404; only listed client routes fall back
 * to the shell with 200.
 */
export function redirectsFile(input: {
  readonly removedPostSlugs: readonly string[];
  readonly clientRoutes: readonly string[];
  readonly shell: string;
  readonly gone: string;
  readonly notFound: string;
}): string {
  const lines = ["# Generated at publication. Paths with a file are served before these rules."];
  for (const slug of [...input.removedPostSlugs].sort()) {
    lines.push(`/posts/${slug} ${input.gone} 410`, `/posts/${slug}/ ${input.gone} 410`);
  }
  for (const route of input.clientRoutes) lines.push(`${route} ${input.shell} 200`);
  lines.push(`/posts/* ${input.notFound} 404`, `/* ${input.notFound} 404`);
  return lines.join("\n") + "\n";
}

/** Primary-host response headers (Cloudflare Workers Static Assets format). */
export function headersFile(bootScriptSha256: string): string {
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${bootScriptSha256}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
  return [
    "/*",
    `  Content-Security-Policy: ${policy}`,
    "  Strict-Transport-Security: max-age=31536000",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: microphone=(self)",
    "/app/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/app/boot.js",
    "  Cache-Control: public, max-age=60",
    "/app/release.json",
    "  Cache-Control: public, max-age=60",
    "",
  ].join("\n");
}

export interface ManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
}
export type ViteManifest = Readonly<Record<string, ManifestChunk>>;

/** The entry chunk and every chunk reachable through static imports. */
export function staticGraph(manifest: ViteManifest, entryKey: string): ManifestChunk[] {
  const out: ManifestChunk[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`manifest has no chunk ${key}`);
    out.push(chunk);
    for (const next of chunk.imports ?? []) visit(next);
  };
  visit(entryKey);
  return out;
}

/** The unhashed loader: release stylesheets, preloads, then the hashed entry. */
export function bootLoader(input: { readonly version: string; readonly entry: string; readonly preloads: readonly string[]; readonly styles: readonly string[] }): string {
  return [
    `// Pirate community web client boot loader for release ${input.version}.`,
    "// Short-cache and unhashed: a rollback repoints this file, nothing else.",
    `for (const href of ${JSON.stringify(input.styles)}) {`,
    `  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; document.head.append(link);`,
    "}",
    `for (const href of ${JSON.stringify(input.preloads)}) {`,
    `  const link = document.createElement("link"); link.rel = "modulepreload"; link.href = href; document.head.append(link);`,
    "}",
    `import(${JSON.stringify(input.entry)});`,
    "",
  ].join("\n");
}

export interface BudgetLine {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export function initialBudget(lines: readonly BudgetLine[], limit = INITIAL_JS_BUDGET_BYTES) {
  const total = lines.reduce((sum, line) => sum + line.gzipBytes, 0);
  return { limitGzipBytes: limit, totalGzipBytes: total, withinBudget: total <= limit, lines };
}

export interface FileDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
