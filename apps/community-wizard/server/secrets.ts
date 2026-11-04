import { infisicalAuth, type InfisicalConnection } from "./infisical-auth.ts";
import type { InfisicalSDK } from "@infisical/sdk";
import {
  requiredSecrets,
  SetupError,
  type SecretName,
  type Settings,
} from "./model.ts";

export interface SecretStore {
  connection?: InfisicalConnection;
  prepare?(settings: Settings): Promise<void>;
  save(
    settings: Settings,
    values: Partial<Record<SecretName, string>>,
  ): Promise<SecretName[]>;
  read(settings: Settings): Promise<Record<string, string>>;
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
async function readRequired(s: Settings, sdk: InfisicalSDK) {
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
}
export function createInfisicalStore(auth = infisicalAuth()): SecretStore {
  return {
    connection: auth.connection,
    async prepare(s) {
      if (s.moderationMode !== "independent")
        throw new SetupError(
          "Managed moderation does not use community provider secrets.",
          409,
        );
      const sdk = await auth.client();
      if (auth.connection.mode === "machine") {
        // Existing unattended identities can remain restricted to the leaf folder.
        await sdk
          .secrets()
          .listSecrets({
            ...scope(s),
            recursive: false,
            viewSecretValue: false,
          });
        return;
      }
      let path = "/";
      for (const name of s.secretPath.slice(1).split("/")) {
        const scope = {
          projectId: s.projectId,
          environment: s.environment,
          path,
        };
        const list = () =>
          sdk.folders().listFolders({ ...scope, recursive: false });
        if (!(await list()).some((folder) => folder.name === name)) {
          try {
            await sdk.folders().create({ ...scope, name });
          } catch (error) {
            // A concurrent creation or uncertain response is resolved by readback.
            if (!(await list()).some((folder) => folder.name === name))
              throw error;
          }
          if (!(await list()).some((folder) => folder.name === name))
            throw new SetupError(
              "Infisical folder creation has not been confirmed. Retry connection.",
              409,
            );
        }
        path = `${path === "/" ? "" : path}/${name}`;
      }
      await sdk
        .secrets()
        .listSecrets({ ...scope(s), recursive: false, viewSecretValue: false });
    },
    async save(s, values) {
      if (s.moderationMode !== "independent")
        throw new SetupError(
          "Managed moderation keeps provider keys in the operator service, not this community.",
          409,
        );
      const sdk = await auth.client();
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
      const readback = await readRequired(s, sdk);
      for (const [name, value] of Object.entries(values))
        if (readback[name] !== value)
          throw new SetupError(
            "Infisical did not confirm the saved credential values. Retry saving.",
            409,
          );
      return Object.keys(readback) as SecretName[];
    },
    async read(s) {
      if (!requiredSecrets(s).length) return {};
      const sdk = await auth.client();
      return readRequired(s, sdk);
    },
  };
}
