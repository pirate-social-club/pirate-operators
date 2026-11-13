// Browser orchestration adapted from pirate-web-solid c7cb8783.
// Execute only in a coordinator-owned exact-source qualification slot.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { MINIMAL_VIEWPORTS } from "storybook/viewport";
import { installAuditChannel } from "./audit-channel.mjs";
import { bindBrowser, verifyBrowserUnchanged } from "./audit-browser.mjs";
import { parseIndex, sizesFor, summarize } from "./audit-results.mjs";
import { captureAndClassify, createHostEvidence } from "./audit-observation.mjs";

export function parseOptions(argv) {
  const options = { timeout: 30_000 };
  const names = new Map([
    ["--base-url", "baseUrl"], ["--out", "out"],
    ["--source-ref", "sourceRef"], ["--source-seal", "sourceSeal"],
    ["--timeout-ms", "timeout"],
    ["--browser-executable", "browserExecutable"], ["--browser-sha256", "browserSha256"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    if (!name || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Unknown option or missing argument: " + argv[index]);
    }
    options[name] = argv[index + 1];
  }
  const base = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username || base.password || base.search || base.hash || base.pathname !== "/"
  ) throw new Error("Use a loopback Storybook origin only");
  options.baseUrl = base.origin;
  if (!options.out || !/^[a-f0-9]{40}$/u.test(options.sourceRef ?? "") ||
    !/^[a-f0-9]{64}$/u.test(options.sourceSeal ?? "")) {
    throw new Error("Output directory, exact source ref and source-manifest SHA256 required");
  }
  if (!path.isAbsolute(options.browserExecutable ?? "") ||
    !/^[a-f0-9]{64}$/u.test(options.browserSha256 ?? "")) {
    throw new Error("Exact browser executable and SHA256 required");
  }
  options.timeout = Number(options.timeout);
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 120_000) {
    throw new Error("Timeout must be between 1 and 120000ms");
  }
  return options;
}

async function isolatedContext(browser, options, size, onBlocked) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === options.baseUrl) {
      return route.continue();
    }
    onBlocked({ kind: "request", origin: url.origin, pathname: url.pathname });
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    onBlocked({ kind: "websocket", origin: url.origin, pathname: url.pathname });
    socket.close();
  });
  return context;
}

async function readMetadata(browser, options, stories) {
  const blocked = [];
  const context = await isolatedContext(browser, options, { width: 1440, height: 1000 },
    (entry) => blocked.push(entry));
  try {
    const page = await context.newPage();
    await page.addInitScript(installAuditChannel);
    await page.goto(options.baseUrl + "/iframe.html", {
      waitUntil: "domcontentloaded", timeout: options.timeout,
    });
    await page.waitForFunction(
      () => Boolean(globalThis.__STORYBOOK_PREVIEW__?.storyStoreValue),
      null, { timeout: options.timeout },
    );
    const metadata = await page.evaluate(async (ids) => {
      const store = globalThis.__STORYBOOK_PREVIEW__.storyStoreValue;
      const output = {};
      for (const id of ids) {
        const story = await store.loadStory({ storyId: id });
        output[id] = {
          globalsViewport: story.storyGlobals?.viewport ?? null,
          parameterViewport: story.parameters?.viewport ?? null,
        };
      }
      if (globalThis.__PIRATE_STORY_AUDIT__?.phases.length) {
        throw new Error("Metadata preparation unexpectedly rendered a story");
      }
      return output;
    }, stories.map((story) => story.id));
    if (blocked.length) throw new Error("Metadata preparation attempted external network or WebSocket");
    return metadata;
  } finally {
    await context.close();
  }
}

async function runStory(browser, options, story, size, ordinal) {
  const host = createHostEvidence();
  const context = await isolatedContext(browser, options, size,
    (entry) => host.record("blocked", entry));
  const page = await context.newPage();
  const key = story.id + "@" + size.name;
  const onPageError = (error) => host.record("errors", error.message);
  const onConsole = (message) => {
    if (message.type() === "error") host.record("consoleErrors", message.text());
  };
  try {
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    await page.addInitScript(installAuditChannel);
    const url = new URL("/iframe.html", options.baseUrl);
    url.searchParams.set("id", story.id);
    url.searchParams.set("viewMode", "story");
    if (size.global) {
      url.searchParams.set("globals", "viewport.value:" + size.global.value +
        (size.global.isRotated ? ";viewport.isRotated:!true" : ""));
    }
    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: options.timeout });
      await page.waitForFunction((id) => {
        const state = globalThis.__PIRATE_STORY_AUDIT__;
        return state?.channelReady && state.events.some((event) =>
          event.name === "storyFinished" && event.storyId === id && event.payload?.storyId === id);
      }, story.id, { timeout: options.timeout });
    } catch (error) {
      host.record("errors", error.message);
    }
    return await captureAndClassify({
      id: story.id, size,
      metadata: { key, id: story.id, importPath: story.importPath, size },
      capture: async () => {
        const screenshot = String(ordinal).padStart(4, "0") + ".png";
        await page.screenshot({ path: path.join(options.out, screenshot), timeout: options.timeout });
        return {
          path: screenshot,
          sha256: createHash("sha256").update(await readFile(path.join(options.out, screenshot))).digest("hex"),
        };
      },
      closeWindow: async () => {
        // This evaluate is ordered after screenshot capture and file hashing.
        // Seal the browser collector, then synchronously close host buffers.
        const raw = await page.evaluate(() =>
          globalThis.__PIRATE_STORY_AUDIT__?.seal() ?? null).catch((error) => {
          host.record("errors", error.message);
          return null;
        });
        const final = host.close(raw, page.viewportSize());
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
        return final;
      },
    });
  } finally {
    await context.close();
  }
}

export async function runAudit(options) {
  const run = {
    sourceRef: options.sourceRef, sourceSeal: options.sourceSeal,
    baseUrl: options.baseUrl, startedAt: new Date().toISOString(),
    expected: [], results: [],
  };
  // Never overwrite an earlier receipt or screenshot set.
  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await mkdir(options.out);
  let browser;
  try {
    run.browserBinding = await bindBrowser(options.browserExecutable, options.browserSha256);
    const response = await fetch(options.baseUrl + "/index.json", {
      signal: AbortSignal.timeout(options.timeout), redirect: "error",
    });
    if (!response.ok) throw new Error("Storybook index HTTP " + response.status);
    const index = await response.json();
    run.indexSha256 = createHash("sha256").update(JSON.stringify(index)).digest("hex");
    await writeFile(path.join(options.out, "index.json"), JSON.stringify(index, null, 2) + "\n");
    const stories = parseIndex(index);
    run.catalog = stories;
    browser = await chromium.launch({ headless: true, executablePath: run.browserBinding.executablePath });
    run.browserVersion = browser.version();
    run.nodeVersion = process.version;
    const metadata = await readMetadata(browser, options, stories);
    const matrix = stories.flatMap((story) =>
      sizesFor(metadata[story.id], MINIMAL_VIEWPORTS).map((size) => ({ story, size })));
    run.expected = matrix.map(({ story, size }) => story.id + "@" + size.name);
    for (const [index, { story, size }] of matrix.entries()) {
      const result = await runStory(browser, options, story, size, index + 1);
      run.results.push(result);
      await writeFile(
        path.join(options.out, "results.jsonl"),
        JSON.stringify(result) + "\n", { flag: "a" },
      );
    }
  } catch (error) {
    run.startupError = { name: error.name, message: error.message };
  } finally {
    if (browser) await browser.close().catch((error) => {
      run.cleanupError = error.message;
      run.startupError ??= { name: "CleanupError", message: error.message };
    });
  }
  if (run.browserBinding) {
    await verifyBrowserUnchanged(run.browserBinding).catch((error) => {
      run.startupError ??= { name: "BrowserIntegrityError", message: error.message };
    });
  }
  run.finishedAt = new Date().toISOString();
  run.summary = summarize(run);
  await writeFile(path.join(options.out, "run.json"), JSON.stringify(run, null, 2) + "\n");
  return run;
}

if (process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const run = await runAudit(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(run.summary, null, 2));
    process.exitCode = run.summary.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
