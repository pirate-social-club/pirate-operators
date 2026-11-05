import type { InfisicalSDK } from "@infisical/sdk";
import { text, requireThat, SetupFailure } from "./model.ts";
import { readSecret, validCredential } from "./private-input.ts";

export const bootstrapNames = {
  filebase: ["FILEBASE_ACCESS_KEY_ID", "FILEBASE_SECRET_ACCESS_KEY"],
  acrcloud: ["ACRCLOUD_CONSOLE_TOKEN"],
  openai: ["OPENAI_ADMIN_KEY"],
} as const;
export function credentialLabel(name: string): string {
  if (name === "FILEBASE_ACCESS_KEY_ID") return "Access token";
  if (name === "FILEBASE_SECRET_ACCESS_KEY") return "Secret key";
  return name;
}
export type CredentialTarget = {
  provider: keyof typeof bootstrapNames;
  projectId: string;
  environment: string;
  secretPath: string;
};
export function credentialTarget(
  options: Record<string, string>,
): CredentialTarget {
  const provider = options["--provider"] ?? "filebase";
  requireThat(
    provider in bootstrapNames && Object.hasOwn(bootstrapNames, provider),
    "unknown_provider",
  );
  return {
    provider: provider as CredentialTarget["provider"],
    projectId: text(
      options["--project-id"],
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
    ),
    environment: text(options["--environment"], /^[A-Za-z0-9_-]{1,64}$/),
    secretPath: text(
      options["--bootstrap-path"],
      /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/,
    ),
  };
}
export async function prepareFolders(
  sdk: InfisicalSDK,
  projectId: string,
  environment: string,
  destination: string,
) {
  let path = "/";
  for (const name of destination.slice(1).split("/")) {
    const scope = { projectId, environment, path };
    const exists = async () =>
      (await sdk.folders().listFolders({ ...scope, recursive: false })).some(
        (folder) => folder.name === name,
      );
    if (!(await exists())) {
      try {
        await sdk.folders().create({ ...scope, name });
      } catch {
        requireThat(await exists(), "vault_folder_not_confirmed");
      }
      requireThat(await exists(), "vault_folder_not_confirmed");
    }
    path = `${path === "/" ? "" : path}/${name}`;
  }
}
export async function prepareCredentials(
  target: CredentialTarget,
  sdk: InfisicalSDK,
  prompt: (name: string) => Promise<string> = (name) =>
    readSecret(credentialLabel(name)),
  replace = false,
) {
  try {
    return await storeCredentials(target, sdk, prompt, replace);
  } catch (error) {
    if (error instanceof SetupFailure) throw error;
    throw new SetupFailure("credential_store_access_failed_details_withheld");
  }
}
async function storeCredentials(
  target: CredentialTarget,
  sdk: InfisicalSDK,
  prompt: (name: string) => Promise<string>,
  replace: boolean,
) {
  // Validate library callers too, before any vault request.
  credentialTarget({
    "--provider": target.provider,
    "--project-id": target.projectId,
    "--environment": target.environment,
    "--bootstrap-path": target.secretPath,
  });
  await prepareFolders(
    sdk,
    target.projectId,
    target.environment,
    target.secretPath,
  );
  const scope = {
    projectId: target.projectId,
    environment: target.environment,
    secretPath: target.secretPath,
    includeImports: false,
    expandSecretReferences: false,
  };
  const names = bootstrapNames[target.provider];
  const listed = await sdk
    .secrets()
    .listSecrets({ ...scope, recursive: false, viewSecretValue: false });
  const existing = new Set(listed.secrets.map((secret) => secret.secretKey));
  const present = names.filter((name) => existing.has(name));
  requireThat(
    target.provider !== "filebase" ||
      replace ||
      present.length === 0 ||
      present.length === names.length,
    "partial_filebase_pair_requires_explicit_replace",
  );
  const pending: Record<string, string> = {};
  const kept: string[] = [],
    saved: string[] = [];
  try {
    for (const name of names) {
      if (existing.has(name) && !replace) {
        const current = await sdk
          .secrets()
          .getSecret({ ...scope, secretName: name });
        requireThat(
          validCredential(current.secretValue),
          "existing_placeholder_requires_explicit_replace",
        );
        kept.push(name);
      } else {
        const value = await prompt(name);
        requireThat(
          validCredential(value),
          "empty_or_placeholder_credential_refused",
        );
        pending[name] = value;
      }
    }
    // No secret writes occur until all requested values have been entered.
    for (const [name, value] of Object.entries(pending)) {
      try {
        if (existing.has(name))
          await sdk
            .secrets()
            .updateSecret(name, { ...scope, secretValue: value });
        else
          await sdk
            .secrets()
            .createSecret(name, { ...scope, secretValue: value });
      } catch {
        // Uncertain writes are successful only after exact readback.
        const actual = await sdk
          .secrets()
          .getSecret({ ...scope, secretName: name })
          .catch(() => undefined);
        requireThat(
          actual?.secretValue === value,
          "bootstrap_secret_write_unconfirmed",
        );
      }
      const actual = await sdk
        .secrets()
        .getSecret({ ...scope, secretName: name });
      requireThat(
        actual.secretValue === value,
        "bootstrap_secret_readback_mismatch",
      );
      saved.push(name);
    }
    return { ...target, saved, kept, values: "withheld", providerRequests: 0 };
  } finally {
    for (const name of Object.keys(pending)) pending[name] = "";
  }
}
