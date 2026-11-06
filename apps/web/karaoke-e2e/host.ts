// Loopback-only acceptance host for the standalone Karaoke build. It serves
// the built screen and a fixture manifest with a generated backing track.
// Never packaged or deployed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fixtureInstrumentalWav, karaokeFixtureLines } from "./fixture.ts";

const dist = resolve("dist/karaoke");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const wav = fixtureInstrumentalWav();

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/__fixture/karaoke.json") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    return response.end(
      JSON.stringify({
        title: "Fixture song",
        instrumentalUrl: "/__fixture/instrumental.wav",
        lines: karaokeFixtureLines,
      }),
    );
  }
  if (path === "/__fixture/instrumental.wav") {
    response.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": wav.length,
      "accept-ranges": "none",
    });
    return response.end(wav);
  }
  const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(dist + sep)) {
    response.writeHead(404);
    return response.end();
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(4178, "127.0.0.1");
