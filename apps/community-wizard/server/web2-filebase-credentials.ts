import { CommunityError, insist } from "../../../packages/community/common.ts";
import { infisicalAuth, siteOrigin } from "./infisical-auth.ts";
import {
  prepareInfisicalScope, scopedInfisicalSecrets, type InfisicalScope,
} from "./secrets.ts";

type FilebaseAuth = Pick<ReturnType<typeof infisicalAuth>, "connection" | "client"> &
  Partial<Pick<ReturnType<typeof infisicalAuth>, "cliAvailable">>;

type FilebaseStatus = "unchecked" | "missing" | "unverified" | "saved" | "ready";

function tokenFrom(value: unknown, code: string, status: number) {
  insist(
    typeof value === "string" && /^[\x21-\x7e]{1,4096}(?![\s\S])/.test(value),
    code, status,
  );
  return value;
}

export function createWeb2FilebaseCredentials(input: {
  scope: InfisicalScope & { siteUrl: string };
  secretName: string;
  /** Reconcile the admitted reference and prove the exact value through the key agent. */
  bind(value: Uint8Array): Promise<void>;
  auth?: FilebaseAuth;
}) {
  const scope = Object.freeze({
    siteUrl: siteOrigin(input.scope.siteUrl),
    projectId: input.scope.projectId,
    environment: input.scope.environment,
    secretPath: input.scope.secretPath,
  });
  const secretName = input.secretName;
  insist(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/i.test(scope.projectId) &&
    /^[a-z][a-z0-9-]{0,30}(?![\s\S])/.test(scope.environment) &&
    /^\/(?=.{1,240}$)(?:[a-zA-Z0-9_-]+\/){0,7}[a-zA-Z0-9_-]+(?![\s\S])/.test(scope.secretPath) &&
    /^[A-Z][A-Z0-9_]{0,127}(?![\s\S])/.test(secretName),
    "web2_filebase_scope_invalid", 503,
  );
  const auth = input.auth ?? infisicalAuth();
  const { mode, siteUrl } = auth.connection;
  insist(siteUrl === scope.siteUrl, "web2_filebase_scope_invalid", 503);
  const bind = input.bind.bind(input);
  let cliAvailable: boolean | undefined;
  let connected = false;
  let status: FilebaseStatus = "unchecked";

  async function openScope(prepare: boolean) {
    connected = false;
    status = "unchecked";
    try {
      const sdk = await auth.client();
      const vault = scopedInfisicalSecrets(scope, sdk);
      const names = prepare
        ? await prepareInfisicalScope(scope, { mode, siteUrl }, sdk)
        : await vault.names();
      if (mode === "cli") cliAvailable = true;
      connected = true;
      status = names.has(secretName) ? "unverified" : "missing";
      return { vault, exists: names.has(secretName) };
    } catch {
      cliAvailable = await auth.cliAvailable?.().catch(() => undefined);
      throw new CommunityError(
        cliAvailable === false ? "web2_filebase_cli_unavailable" : "web2_filebase_scope_unavailable", 409,
      );
    }
  }
  async function read(vault: ReturnType<typeof scopedInfisicalSecrets>) {
    try {
      return tokenFrom(await vault.read(secretName), "web2_filebase_readback_unavailable", 409);
    } catch {
      throw new CommunityError("web2_filebase_readback_unavailable", 409);
    }
  }
  async function activate(token: string) {
    status = "saved";
    const bytes = new TextEncoder().encode(token);
    try {
      await bind(bytes);
      status = "ready";
    } catch {
      throw new CommunityError("web2_filebase_binding_unavailable", 409);
    } finally {
      bytes.fill(0);
    }
  }
  async function check(prepare: boolean) {
    const { vault, exists } = await openScope(prepare);
    if (exists) await activate(await read(vault));
  }
  return {
    snapshot() {
      return { scope, mode, cliAvailable, connected, status };
    },
    async restore() {
      try { await check(false); } catch {
        // Keep the paired runner reachable so the operator can correct setup.
      }
    },
    connect: () => check(true),
    async save(value: unknown) {
      insist(connected, "web2_filebase_scope_required", 409);
      const selected = tokenFrom(value, "web2_filebase_credential_invalid", 400);
      const { vault, exists } = await openScope(false);
      if (!exists) {
        status = "unverified";
        try {
          await vault.write(secretName, selected);
        } catch {
          // Create is never converted to an update. Resolve a lost response by
          // reading the same name in the original scope.
        }
      }
      const retained = await read(vault);
      insist(retained === selected, "web2_filebase_credential_conflict", 409);
      await activate(retained);
    },
    async assertReady() {
      await check(false);
      insist(status === "ready", "web2_filebase_credential_required", 409);
    },
  };
}

export type Web2FilebaseCredentials = ReturnType<typeof createWeb2FilebaseCredentials>;
export type Web2FilebaseView = ReturnType<Web2FilebaseCredentials["snapshot"]>;
