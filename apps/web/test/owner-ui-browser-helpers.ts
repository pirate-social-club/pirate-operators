import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

export const origin = "https://ui.example";
/** A generated eight-second PCM tone exercises Chromium's real audio decoder. */
function wave() {
  const rate = 8000,
    frames = rate * 8,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++)
    bytes.writeInt16LE(
      Math.round(1000 * Math.sin((2 * Math.PI * 440 * frame) / rate)),
      44 + frame * 2,
    );
  return bytes;
}
export async function sourceFixture(
  page: Page,
  query: string,
  options: { failFirstAudio?: boolean } = {},
) {
  const errors: string[] = [],
    unexpected: string[] = [];
  let failAudio = options.failFirstAudio === true;
  page.on("pageerror", (error) => errors.push(error.message));
  const audio = wave();
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (/^\/fixture-(song|a|b)\.wav$/.test(url.pathname)) {
      if (failAudio) {
        failAudio = false;
        return route.fulfill({ status: 404 });
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(
        request.headers()["range"] ?? "",
      );
      if (range) {
        const start = Number(range[1]),
          end = range[2]
            ? Math.min(Number(range[2]), audio.length - 1)
            : audio.length - 1;
        return route.fulfill({
          status: 206,
          contentType: "audio/wav",
          body: audio.subarray(start, end + 1),
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${audio.length}`,
          },
        });
      }
      return route.fulfill({ contentType: "audio/wav", body: audio });
    }
    if (url.pathname.startsWith("/api/")) {
      unexpected.push(url.pathname);
      return route.abort();
    }
    const root = resolve("../../.local/owner-ui-browser-20261111/browser-dist");
    const file = resolve(
      root,
      url.pathname.startsWith("/app/assets/")
        ? url.pathname.slice(1)
        : "owner-ui.fixture.html",
    );
    if (!file.startsWith(root + "/"))
      throw new Error("Fixture asset escaped isolated build");
    const mime: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    return route.fulfill({
      body: await readFile(file),
      contentType: mime[extname(file)] ?? "text/html",
    });
  });
  await page.goto(`${origin}/?${query}`);
  return { errors, unexpected };
}
