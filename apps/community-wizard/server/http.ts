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
import type { Web2Setup } from "./web2-setup.ts";
import { CommunityError, exact, object } from "../../../packages/community/common.ts";
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
    web2?: Web2Setup;
    authorizeWeb2?: (request: IncomingMessage, action: "read" | "write") => Promise<void>;
    linux?: LinuxSetup;
    authorizeLinux?: (
      request: IncomingMessage,
      action: "read" | "write",
    ) => Promise<void>;
  } = {},
) {
  if (integrations.web2 && !integrations.authorizeWeb2)
    throw new SetupError("Web2 setup requires an actual paired authenticated operator channel.", 503);
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
    res.setHeader("Referrer-Policy", integrations.web2 ? "strict-origin" : "no-referrer");
    if (integrations.web2) res.setHeader("Permissions-Policy", 'publickey-credentials-create=(self "https://account.megaeth.com"), publickey-credentials-get=(self "https://account.megaeth.com")');
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${integrations.web2 ? " https://*.megaeth.com; frame-src https://*.megaeth.com" : ""}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
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
              web2Available: Boolean(integrations.web2),
            }
          : {
              available: false,
              csrf,
              legacyAvailable: Boolean(setup),
              web2Available: Boolean(integrations.web2),
              correction:
                "The Linux deployment and naming adapters are not connected to this runner. Saved settings or credentials cannot deploy an application until its owning backend is installed.",
            };
      if (req.method === "GET" && path === "/api/linux/state") {
        if (integrations.web2) await integrations.authorizeWeb2!(req, "read");
        if (integrations.linux) await integrations.authorizeLinux!(req, "read");
        json(200, await linuxState());
        return;
      }
      if (req.method === "GET" && path === "/api/web2/state") {
        if (!integrations.web2) throw new CommunityError("web2_setup_unavailable", 503);
        await integrations.authorizeWeb2!(req, "read");
        json(200, { available: true, csrf, view: integrations.web2.snapshot() });
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
        if (path.startsWith("/api/web2/")) {
          if (!integrations.web2) throw new CommunityError("web2_setup_unavailable", 503);
          await integrations.authorizeWeb2!(req, "write");
          const action = path.slice("/api/web2/".length);
          if (action === "draft") {
            const draftInput = object(await body(req, 4096));
            const restore = draftInput.action === "read";
            if (restore) exact(draftInput, ["action"]);
            // A stalled body can outlive the paired session.
            await integrations.authorizeWeb2!(req, "write");
            json(200, restore
              ? integrations.web2.operatorDraft()
              : integrations.web2.saveOperatorDraft(draftInput));
            return;
          }
          const view = await integrations.web2.send(action, await body(req, action === "filebase-save" ? 8192 : 196_608));
          json(200, { available: true, csrf, view });
          return;
        }
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
      if (error instanceof CommunityError)
        json(error.status, { code: error.code, error: web2Corrections[error.code] ?? "This Web2 step did not complete. Retain the original request and reconcile before retrying." });
      else if (error instanceof LinuxInputError)
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

const web2Corrections: Record<string,string> = {
  web2_pairing_only: "This pairing session is read-only.",
  web2_filebase_onboarding_unavailable: "This runner uses its preselected Filebase credential.",
  web2_filebase_cli_unavailable: "Install the Infisical CLI on the wizard runner, then check the folder again.",
  web2_filebase_scope_unavailable: "Check the runner's Infisical login or machine identity and its access to the displayed project, environment and folder.",
  web2_filebase_scope_required: "Check the displayed Infisical folder before entering the Filebase credential.",
  web2_filebase_credential_required: "Save and verify the Filebase credential before preparing enrollment.",
  web2_filebase_credential_invalid: "Enter the Filebase IPFS RPC token without whitespace.",
  web2_filebase_readback_unavailable: "Infisical could not confirm the saved Filebase credential. Check the same folder again before retrying.",
  web2_filebase_credential_conflict: "The selected folder already has a different Filebase credential. Check the saved value with the host operator.",
  web2_filebase_binding_unavailable: "The Filebase credential is saved in Infisical. Check the key agent on the wizard runner, then check the folder again.",
  publisher_custody_binding_unavailable:"The preprovisioned server publisher custody binding is unavailable. No new enrollment or gas allocation is authorized.",
  web2_publishing_authority_unavailable:"Authenticated Pirate grant selection and admission are unavailable. Retain this enrollment; publishing and installation are unavailable.",
  web2_managed_grant_admission_unavailable:"The managed service has not confirmed this exact grant admission. Reconcile the retained attachment before retrying.",
  web2_browser_publisher_proof_refused:"The server publisher must sign through its configured custody binding. Browser publisher proofs cannot authorize a new gas allocation.",
  web2_original_authorization_changed:"This runner already retains the accepted authorization. Reload and reconcile its original bytes.",
  web2_publishing_attachment_required:"Complete the separate owner review and reconcile managed grant admission before installation.",
  web2_controller_address_invalid: "Enter a complete controller address with a valid checksum, or use its lowercase form. Nothing new was prepared.",
  web2_publisher_address_invalid: "Enter a complete publisher address with a valid checksum, or use its lowercase form. Nothing new was prepared.",
  web2_setup_unavailable: "The hosted Web2 setup adapter is not connected to this runner.",
  web2_installation_unavailable: "The real Linux Web2 installer is unavailable. Enrollment is retained; nothing is reported installed.",
  hosted_signing_request_changed: "The service returned different signing terms. No wallet request is authorized. Reconnect to the selected service.",
  web2_revision_changed: "Another tab or request advanced setup. Refresh the original runner before continuing.",
  web2_original_selection_changed: "This runner retains an existing community request. Reconcile that original instead of replacing it.",
  web2_operator_draft_invalid: "Check the draft fields and try saving again.",
  web2_operator_draft_changed: "This draft changed in another Wizard tab. Reload to use the saved draft.",
  web2_operator_draft_closed: "The retained setup already owns these inputs. Refresh it before continuing.",
  web2_registration_challenge_expired: "The saved registration challenge expired. Reconcile the original enrollment to check its status.",
  hosted_request_refused: "The hosted service refused this step or is unavailable. Keep the original request and check enrollment status.",
  pilot_notice_required: "Read and accept the selected pilot notice before preparation.",
  invalid_invite: "Use the complete 64-character invitation from the pilot service.",
  hosted_invitation_refused: "The service refused this invitation before preparation. You may correct it while keeping this community selection.",
  hosted_authorization_refused: "The service rejected the authorization before new effects. Select the named account and authorize again; the community request is retained.",
};
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
