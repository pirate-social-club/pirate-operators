import assert from "node:assert/strict";
import { test } from "node:test";
import { bootLoader, headersFile, initialBudget, redirectsFile, staticGraph } from "../scripts/lib/release.ts";

test("redirects give removed posts 410, client routes 200 and everything else 404", () => {
  const file = redirectsFile({ removedPostSlugs: ["b-post", "a-post"], clientRoutes: ["/about"], shell: "/app/shell.html", gone: "/public/gone.html", notFound: "/public/not-found.html" });
  const rules = file.split("\n").filter(line => line !== "" && !line.startsWith("#"));
  assert.deepEqual(rules, [
    "/posts/a-post /public/gone.html 410",
    "/posts/a-post/ /public/gone.html 410",
    "/posts/b-post /public/gone.html 410",
    "/posts/b-post/ /public/gone.html 410",
    "/about /app/shell.html 200",
    "/posts/* /public/not-found.html 404",
    "/* /public/not-found.html 404",
  ]);
  assert.ok(!rules.some(rule => rule.startsWith("/* ") && rule.endsWith(" 200")), "no catch-all 200 fallback");
});

test("primary headers carry the contract policy, including frame-ancestors", () => {
  const file = headersFile("abc=");
  for (const fragment of ["frame-ancestors 'none'", "script-src 'self' 'sha256-abc='", "base-uri 'none'", "object-src 'none'",
    "Strict-Transport-Security:", "X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin", "Permissions-Policy: microphone=(self)"]) {
    assert.ok(file.includes(fragment), fragment);
  }
});

test("static graph follows imports once and ignores dynamic imports", () => {
  const graph = staticGraph({
    entry: { file: "app/assets/entry.js", imports: ["shared", "dup"], dynamicImports: ["lazy"] },
    shared: { file: "app/assets/shared.js", imports: ["dup"] },
    dup: { file: "app/assets/dup.js" },
    lazy: { file: "app/assets/lazy.js" },
  }, "entry");
  assert.deepEqual(graph.map(chunk => chunk.file), ["app/assets/entry.js", "app/assets/shared.js", "app/assets/dup.js"]);
  assert.throws(() => staticGraph({}, "missing"), /no chunk missing/);
});

test("budget sums every initial line and fails above the limit", () => {
  const lines = [{ path: "a", bytes: 10, gzipBytes: 60_000 }, { path: "b", bytes: 10, gzipBytes: 40_000 }];
  assert.equal(initialBudget(lines).withinBudget, true);
  assert.equal(initialBudget([...lines, { path: "c", bytes: 1, gzipBytes: 1 }]).withinBudget, false);
});

test("boot loader imports the hashed entry after styles and preloads", () => {
  const source = bootLoader({ version: "1", entry: "/app/assets/e.js", preloads: ["/app/assets/p.js"], styles: ["/app/assets/s.css"] });
  assert.ok(source.indexOf("s.css") < source.indexOf("p.js") && source.indexOf("p.js") < source.indexOf('import("/app/assets/e.js")'));
});
