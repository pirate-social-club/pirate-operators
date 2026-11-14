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
import type { LinuxSetup } from "./linux-setup.ts";
import { LinuxInputError } from "../../../packages/community-setup/shared-linux-profile.ts";

async function body(req: IncomingMessage, limit = 24_576) {
  if (req.headers["content-type"] !== "application/json")
    throw new SetupError("Use application/json.", 415);
  if (Number(req.headers["content-length"] ?? 0) > limit)
    throw new SetupError("Request too large.", 413);
  const chunks: Buffer[] = [];
  let length = 0;
  const timer = setTimeout(
    () => req.destroy(new SetupError("Request timed out.", 408)),
    30_000,
  );
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw new SetupError("Request too large.", 413);
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SetupError("Invalid JSON.");
  }
}
export function createWizardServer(
  setup: Setup | undefined,
  dist: string,
  capabilities: {
    infisical: boolean;
    cloudflare: boolean;
    stateProtection?: boolean;
  },
  integrations: {
    linux?: LinuxSetup;
    authorizeLinux?: (
      request: IncomingMessage,
      action: "read" | "write",
    ) => Promise<void>;
  } = {},
) {
  if (integrations.linux && !integrations.authorizeLinux)
    throw new SetupError(
      "Linux setup requires an actual authenticated operator session or paired SSH-forwarded channel; loopback and CSRF alone are insufficient.",
      503,
    );
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
      const linuxState = async () =>
        integrations.linux
          ? {
              available: true,
              state: integrations.linux.snapshot(),
              capabilities: await integrations.linux.capabilities(),
              csrf,
              legacyAvailable: Boolean(setup),
            }
          : {
              available: false,
              csrf,
              legacyAvailable: Boolean(setup),
              correction:
                "The Linux deployment and naming adapters are not connected to this runner. Saved settings or credentials cannot deploy an application until its owning backend is installed.",
            };
      if (req.method === "GET" && path === "/api/linux/state") {
        if (integrations.linux) await integrations.authorizeLinux!(req, "read");
        json(200, await linuxState());
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        if (!setup)
          throw new SetupError(
            "The legacy Cloudflare setup recipe is not installed on this Linux runner.",
            503,
          );
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
        if (path.startsWith("/api/linux/")) {
          await integrations.authorizeLinux?.(req, "write");
          const linux = integrations.linux;
          if (!linux)
            throw new SetupError(
              "The real Linux lifecycle and naming adapters are unavailable. This runner cannot deploy or restore a community yet.",
              503,
            );
          if (path === "/api/linux/backup") {
            if (req.headers["content-type"] !== "application/octet-stream")
              throw new SetupError(
                "Upload the encrypted backup as application/octet-stream.",
                415,
              );
            const bytes = Number(req.headers["x-backup-size"]);
            if (!Number.isSafeInteger(bytes) || bytes < 1)
              throw new SetupError(
                "Declare the encrypted backup byte length.",
                400,
              );
            req.setTimeout(30_000, () => req.destroy());
            await linux.stageBackup(req, bytes);
          } else {
            const input = await body(req, 196_608);
            if (path === "/api/linux/settings") await linux.configure(input);
            else if (path === "/api/linux/destination")
              await linux.destination(input);
            else if (path === "/api/linux/inspect") await linux.inspect();
            else if (path === "/api/linux/namespace") await linux.namespace();
            else if (path === "/api/linux/namespace/begin") await linux.namespaceBegin();
            else if (path === "/api/linux/namespace/complete") await linux.namespaceComplete(input);
            else if (path === "/api/linux/namespace/recover") await linux.namespaceRecover();
            else if (path === "/api/linux/import")
              await linux.importProfile(input);
            else if (path === "/api/linux/credentials")
              await linux.saveCredentials(input);
            else if (path === "/api/linux/credentials/reconcile")
              await linux.reconcileCredentials();
            else if (path === "/api/linux/credentials/verify")
              await linux.verifyCredentials();
            else if (path === "/api/linux/restore/inspect")
              await linux.inspectBackup(input);
            else if (path === "/api/linux/plan") await linux.review();
            else if (path === "/api/linux/deploy") await linux.deploy(input);
            else if (path === "/api/linux/reconcile") await linux.reconcile();
            else if (path === "/api/linux/cancel") linux.cancel();
            else throw new SetupError("Unknown Linux setup action.", 404);
          }
          json(path === "/api/linux/deploy" ? 202 : 200, await linuxState());
          return;
        }
        if (!setup)
          throw new SetupError(
            "This runner supports only its installed Linux setup API.",
            503,
          );
        const input = await body(req);
        if (path === "/api/learning/settings")
          await setup.configureLearning(input);
        else if (path === "/api/learning/infisical/connect")
          await setup.connectLearningSecrets();
        else if (path === "/api/learning/secrets")
          await setup.saveLearningSecrets(input);
        else if (path === "/api/learning/plan") await setup.reviewLearning();
        else if (path === "/api/settings") await setup.configure(input);
        else if (path === "/api/infisical/connect")
          await setup.connectSecrets();
        else if (path === "/api/secrets") await setup.saveSecrets(input);
        else if (path === "/api/plan") await setup.review();
        else if (path === "/api/deploy") {
          if (
            !capabilities.cloudflare ||
            !capabilities.stateProtection ||
            (setup.snapshot().settings?.moderationMode === "independent" &&
              !capabilities.infisical)
          )
            throw new SetupError(
              "Configure Cloudflare access and state protection on the runner. Independent moderation also requires an Infisical connection.",
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
      if (error instanceof LinuxInputError)
        json(error.code === "operator_pairing_required" ? 401 : 409, {
          error: error.correction,
          code: error.code,
        });
      else if(error && typeof error==="object" && "code" in error && typeof error.code==="string" && namespaceCorrections[error.code])
        json(409,{code:error.code,error:namespaceCorrections[error.code]});
      else if (error instanceof SetupError)
        json(error.status, { error: error.message });
      else
        json(502, {
          error:
            "This step did not complete. Check the runner configuration and service access. Some credentials may already be saved; retry safely. Provider errors are withheld to protect secrets.",
        });
    }
  });
  // Ciphertext is streamed under its separate bounded deadline; JSON bodies
  // retain a 30-second absolute bound and uploads a 30-second idle bound.
  server.requestTimeout = 3_600_000;
  server.headersTimeout = 10_000;
  return server;
}
async function asset(res: ServerResponse, path: string, type: string) {
  const contents = await readFile(path);
  res.writeHead(200, { "Content-Type": type }).end(contents);
}

const namespaceCorrections:Record<string,string> = {
  operator_proof_required:"A supported external namespace control proof is required; begin the retained operator challenge.",
  external_authority_verifier_unavailable:"The genuine external namespace verifier is unavailable. No proof or permission has been granted.",
  needs_owner_delegation:"The selected namespace needs its supported owner-delegation setup before binding.",
  grant_expired:"The namespace binding proof expired. Reconcile existing work and obtain a fresh proof before new effects.",
  setup_context_changed:"The original setup binding changed. Refresh and review; no replacement authority is inferred.",
  authority_changed:"Current namespace authority changed. Existing claims and holders are retained; new work is held.",
  namespace_binding_changed:"Installation, source or namespace differs from the retained binding. Reconcile the original setup.",
};
