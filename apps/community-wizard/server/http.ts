import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SetupError } from "./model.ts";
import type { Setup } from "./setup.ts";

async function body(req: IncomingMessage) {
  if (req.headers["content-type"] !== "application/json")
    throw new SetupError("Use application/json.", 415);
  if (Number(req.headers["content-length"] ?? 0) > 24_576)
    throw new SetupError("Request too large.", 413);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 24_576) throw new SetupError("Request too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SetupError("Invalid JSON.");
  }
}
export function createWizardServer(
  setup: Setup,
  dist: string,
  capabilities: { infisical: boolean; cloudflare: boolean },
) {
  const csrf = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      res.writeHead(503).end();
      return;
    }
    const host = `127.0.0.1:${address.port}`,
      origin = `http://${host}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status: number, value: unknown) => {
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    };
    try {
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new SetupError(
          "Open the wizard at its printed loopback address.",
          403,
        );
      const path = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET" && path === "/api/state") {
        json(200, { ...setup.snapshot(), csrf, capabilities });
        return;
      }
      if (req.method === "POST" && path.startsWith("/api/")) {
        const supplied = req.headers["x-wizard-token"];
        if (
          req.headers.origin !== origin ||
          typeof supplied !== "string" ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(csrf) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))
        )
          throw new SetupError("Setup session expired. Reload the page.", 403);
        const input = await body(req);
        if (path === "/api/settings") await setup.configure(input);
        else if (path === "/api/secrets") await setup.saveSecrets(input);
        else if (path === "/api/plan") await setup.review();
        else if (path === "/api/deploy") {
          if (!capabilities.cloudflare || !capabilities.infisical)
            throw new SetupError(
              "Start the runner with the Cloudflare token and scoped Infisical identity.",
              409,
            );
          await setup.deploy(input);
        } else throw new SetupError("Unknown setup action.", 404);
        json(path === "/api/deploy" ? 202 : 200, {
          ...setup.snapshot(),
          csrf,
          capabilities,
        });
        return;
      }
      if (req.method !== "GET")
        throw new SetupError("Method not allowed.", 405);
      if (path === "/")
        await asset(res, join(dist, "index.html"), "text/html; charset=utf-8");
      else if (/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path))
        await asset(
          res,
          join(dist, path.slice(1)),
          path.endsWith(".js") ? "text/javascript" : "text/css",
        );
      else throw new SetupError("Not found.", 404);
    } catch (error) {
      if (error instanceof SetupError)
        json(error.status, { error: error.message });
      else
        json(502, {
          error:
            "This step did not complete. Check the runner configuration and service access. Some credentials may already be saved; retry safely. Provider errors are withheld to protect secrets.",
        });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
async function asset(res: ServerResponse, path: string, type: string) {
  const contents = await readFile(path);
  res.writeHead(200, { "Content-Type": type }).end(contents);
}
