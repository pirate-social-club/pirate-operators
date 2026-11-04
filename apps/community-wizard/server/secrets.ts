import { InfisicalSDK } from "@infisical/sdk";
import {
  requiredSecrets,
  SetupError,
  type SecretName,
  type Settings,
} from "./model.ts";

export interface SecretStore {
  save(
    settings: Settings,
    values: Partial<Record<SecretName, string>>,
  ): Promise<SecretName[]>;
  read(settings: Settings): Promise<Record<string, string>>;
}
export function infisicalConfigured() {
  return Boolean(
    process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET,
  );
}
async function client() {
  if (!infisicalConfigured())
    throw new SetupError(
      "Start the runner with the scoped Infisical machine identity.",
      409,
    );
  const site = new URL(
    process.env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
  );
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.search ||
    site.hash
  )
    throw new SetupError("Infisical requires a trusted HTTPS site URL.", 409);
  const sdk = new InfisicalSDK({ siteUrl: site.origin });
  await sdk.auth().universalAuth.login({
    clientId: process.env.INFISICAL_CLIENT_ID!,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
  });
  return sdk;
}
function scope(s: Settings) {
  return {
    projectId: s.projectId,
    environment: s.environment,
    secretPath: s.secretPath,
    includeImports: false,
    expandSecretReferences: false,
  };
}
export const infisicalStore: SecretStore = {
  async save(s, values) {
    const sdk = await client();
    const existing = await sdk
      .secrets()
      .listSecrets({ ...scope(s), recursive: false, viewSecretValue: false });
    const names = new Set(existing.secrets.map((secret) => secret.secretKey));
    for (const [name, value] of Object.entries(values)) {
      const options = { ...scope(s), secretValue: value };
      if (names.has(name)) await sdk.secrets().updateSecret(name, options);
      else await sdk.secrets().createSecret(name, options);
    }
    // Re-read only the required names; a failed partial write never claims success.
    const readback = await this.read(s);
    return Object.keys(readback) as SecretName[];
  },
  async read(s) {
    const sdk = await client();
    const result: Record<string, string> = {};
    for (const name of requiredSecrets(s)) {
      const secret = await sdk
        .secrets()
        .getSecret({ ...scope(s), secretName: name });
      if (!secret.secretValue)
        throw new SetupError("A required Infisical credential is empty.", 409);
      result[name] = secret.secretValue;
    }
    return result;
  },
};
