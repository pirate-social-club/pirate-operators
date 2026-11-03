import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import QRCode from "qrcode";
import { page } from "./page.ts";
import type { Probe } from "./probe.ts";

export async function serveProbe(probe: Probe, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("invalid_loopback_port");
  const csrf = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("base64");
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const fail = (code: number) => {
      req.resume();
      res.writeHead(code);
      res.end("Probe request refused");
    };
    if (req.headers.host !== new URL(origin).host) return fail(403);
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(page(csrf, nonce));
      return;
    }
    if (!new Set(["/start", "/poll", "/state", "/reset"]).has(req.url ?? ""))
      return fail(404);
    if (req.method !== "POST") return fail(405);
    if (
      req.headers.origin !== origin ||
      req.headers["x-probe-csrf"] !== csrf ||
      req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0")
    )
      return fail(403);
    try {
      if (req.url === "/start") await probe.start();
      if (req.url === "/poll") await probe.poll();
      if (req.url === "/reset") probe.reset();
      const view = probe.view();
      // SVG is generated locally from a fixed-scheme launch URI; no provider HTML.
      const qr = view.launch
        ? await QRCode.toString(view.launch, { type: "svg", margin: 3 })
        : null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ...view, qr }));
    } catch {
      fail(500);
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("loopback_bind_failed");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    async close() {
      probe.reset();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
