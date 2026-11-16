import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { hashJson } from "../../packages/community/common.ts";
import { sha256 } from "viem";

/** Real owned HTTP between the actual services; only their selected logical
 * origins map to loopback. This does not claim public DNS/TLS acceptance. */
export async function canonicalHttpFixture(
  routes: ReadonlyMap<string, (request: Request) => Promise<Response>>,
  evidenceDirectory=".local/web2-canonical",
) {
  const evidence: Array<Record<string, unknown>> = [];
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on("close", () => controller.abort());
    try {
      const origin = [...routes.keys()].find(
        (x) => new URL(x).host === incoming.headers.host,
      );
      if (!origin) {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 1024 * 1024) throw Error("fixture_http_request_too_large");
        parts.push(chunk);
      }
      const body = Buffer.concat(parts),
        request = new Request(origin + incoming.url, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          signal: controller.signal,
          ...(!["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? { body }
            : {}),
        });
      const response = await routes.get(origin)!(request),
        bytes = new Uint8Array(await response.arrayBuffer());
      const receipt = response.headers.get("x-pirate-canonical-receipt");
      const input=body.length?JSON.parse(body.toString("utf8")):null;
      const publicProof=response.ok&&new URL(request.url).pathname==="/api/internal/catalog"&&
        ["ready","publication","find_publication"].includes(input?.payload?.action)?JSON.parse(new TextDecoder().decode(bytes)):null;
      evidence.push({
        origin,
        method: request.method,
        path: new URL(request.url).pathname,
        requestBytesSha256: sha256(body),
        requestCommitment: body.length
          ? hashJson(JSON.parse(body.toString("utf8")))
          : null,
        status: response.status,
        responseSha256: sha256(bytes),
        receipt: receipt ? JSON.parse(receipt) : null,
        independentProof:publicProof,
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(bytes);
    } catch (error) {
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(
        error instanceof Error ? error.message : "fixture_http_failure",
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    `${evidenceDirectory}/http-${process.pid}-${port}.json`,
    JSON.stringify({ pid: process.pid, port, state: "running" }),
  );
  return {
    evidence,
    port,
    async transport(request: Request) {
      const url = new URL(request.url);
      if (!routes.has(url.origin))
        throw Error("fixture_http_unselected_origin");
      const body = new Uint8Array(await request.arrayBuffer());
      return new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: url.pathname + url.search,
            method: request.method,
            signal: request.signal,
            headers: {
              ...Object.fromEntries(request.headers),
              host: url.host,
              "content-length": String(body.byteLength),
            },
          },
          (incoming) => {
            const parts: Uint8Array[] = [];
            let size = 0;
            incoming.on("data", (part) => {
              size += part.length;
              if (size > 26 * 1024 * 1024)
                incoming.destroy(Error("fixture_http_response_too_large"));
              else parts.push(part);
            });
            incoming.on("error", reject);
            incoming.on("end", () =>
              resolve(
                new Response(Buffer.concat(parts), {
                  status: incoming.statusCode,
                  headers: incoming.headers as Record<string, string>,
                }),
              ),
            );
          },
        );
        outgoing.setTimeout(30000, () =>
          outgoing.destroy(Error("fixture_http_deadline")),
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await writeFile(
        `${evidenceDirectory}/http-${process.pid}-${port}.json`,
        JSON.stringify({ pid: process.pid, port, state: "closed" }),
      );
    },
  };
}
