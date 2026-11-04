// FIXTURE canonical host for local acceptance only.
//
// Serves dist/site on the fixture canonical origin with the primary-host
// headers from dist/host/_headers, evaluates the same _redirects subset an
// IPFS gateway does (exact paths and a trailing *, statuses 200/404/410, only
// for paths with no file), and answers the public read API from fixture data.
// It is not Cloudflare, not the community service and not an acceptance of
// either. The /__fixture/scenario control endpoint exists only here.
import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/site/", import.meta.url));
const headersPath = fileURLToPath(new URL("../dist/host/_headers", import.meta.url));
const port = Number(process.env.FIXTURE_HOST_PORT ?? 4173);
type Scenario = "normal" | "stale" | "removed-after-publish" | "api-down" | "session-slow";
let scenario: Scenario = "normal";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
};

interface Rule { readonly from: string; readonly to: string; readonly status: number }
const matches = (pattern: string, path: string) => pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

async function loadRules(): Promise<Rule[]> {
  const text = await readFile(join(root, "_redirects"), "utf8");
  return text.split("\n").filter(line => line.trim() !== "" && !line.startsWith("#")).map(line => {
    const [from, to, status] = line.trim().split(/\s+/);
    return { from, to, status: Number(status) };
  });
}

async function loadHeaders(): Promise<Array<{ pattern: string; headers: Array<[string, string]> }>> {
  const blocks: Array<{ pattern: string; headers: Array<[string, string]> }> = [];
  for (const line of (await readFile(headersPath, "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) blocks.push({ pattern: line.trim(), headers: [] });
    else {
      const at = line.indexOf(":");
      blocks.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return blocks;
}

async function fileAt(path: string): Promise<string | undefined> {
  const target = normalize(join(root, path));
  if (!target.startsWith(root)) return undefined;
  try {
    const info = await stat(target);
    if (info.isFile()) return target;
    if (info.isDirectory()) {
      const index = join(target, "index.html");
      if ((await stat(index).catch(() => undefined))?.isFile()) return index;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function api(path: string, res: ServerResponse) {
  if (scenario === "api-down") return json(res, 503, { error: "fixture_api_down" });
  if (path === "/api/session") {
    if (scenario === "session-slow") await new Promise(resolve => setTimeout(resolve, 8000));
    return json(res, 401, { error: "session_required" });
  }
  if (path === "/api/public/community") return json(res, 200, JSON.parse(await readFile(join(root, "public/data/community.json"), "utf8")));
  const post = /^\/api\/public\/posts\/([a-z0-9-]+)$/.exec(path);
  if (post !== null) {
    const file = await readFile(join(root, `public/data/posts/${post[1]}.json`), "utf8").catch(() => undefined);
    if (file === undefined) return json(res, 404, { error: "not_found" });
    const record = JSON.parse(file);
    if (post[1] === "first-song" && scenario === "stale") return json(res, 200, { ...record, revision: record.revision + 1, body: "FIXTURE: this body changed after publication." });
    if (post[1] === "first-song" && scenario === "removed-after-publish") return json(res, 200, { kind: "removed", slug: record.slug, revision: record.revision + 1 });
    return json(res, 200, record);
  }
  return json(res, 404, { error: "not_found" });
}

const server = createServer(async (req, res) => {
  // Concatenate rather than resolve: a request path starting with // must stay
  // a path, not become another authority.
  const url = new URL(`http://localhost:${port}${req.url ?? "/"}`);
  const path = decodeURIComponent(url.pathname);
  if (path === "/__fixture/scenario" && req.method === "POST") {
    scenario = (url.searchParams.get("name") ?? "normal") as Scenario;
    return json(res, 200, { scenario });
  }
  for (const block of await loadHeaders()) if (matches(block.pattern, path)) for (const [name, value] of block.headers) res.setHeader(name, value);
  if (path.startsWith("/api/")) return api(path, res);
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });

  let status = 200;
  let file = await fileAt(path);
  if (file !== undefined && !path.endsWith("/") && file.endsWith("index.html") && !path.endsWith("index.html")) {
    res.writeHead(301, { location: `${path}/` });
    return res.end();
  }
  if (file === undefined) {
    const rule = (await loadRules()).find(candidate => matches(candidate.from, path));
    if (rule !== undefined) {
      file = await fileAt(rule.to);
      status = rule.status;
    }
  }
  if (file === undefined) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(status, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : await readFile(file));
});

server.listen(port, "127.0.0.1", () => console.log(`fixture canonical host on http://localhost:${port}`));
