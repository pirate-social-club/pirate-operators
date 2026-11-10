import { infisicalAuth } from "./infisical-auth.ts";
import { SetupError } from "./model.ts";
import type {
  CommunitySetupV1,
  LearningSecretName,
} from "../../../packages/community-setup/manifest.ts";
export interface LearningSecretStore {
  siteUrl: string;
  check(settings: CommunitySetupV1): Promise<LearningSecretName[]>;
  save(
    settings: CommunitySetupV1,
    values: Partial<Record<LearningSecretName, string>>,
  ): Promise<LearningSecretName[]>;
}
/** Values never leave this adapter; snapshots contain names only. */
export function createInfisicalLearningStore(
  auth = infisicalAuth(),
): LearningSecretStore {
  const required = (s: CommunitySetupV1): LearningSecretName[] =>
    s.telegram.enabled
      ? ["ELEVENLABS_API_KEY", "TELEGRAM_BOT_TOKEN"]
      : ["ELEVENLABS_API_KEY"];
  const scope = (s: CommunitySetupV1) => ({
    ...s.infisical,
    includeImports: false,
    expandSecretReferences: false,
  });
  const verify = async (
    s: CommunitySetupV1,
    expected: Partial<Record<LearningSecretName, string>> = {},
  ) => {
    const sdk = await auth.client();
    const existing = await sdk
      .secrets()
      .listSecrets({ ...scope(s), recursive: false, viewSecretValue: false });
    const names: LearningSecretName[] = [];
    for (const name of required(s)) {
      if (!existing.secrets.some((v) => v.secretKey === name)) continue;
      const secret = await sdk
        .secrets()
        .getSecret({ ...scope(s), secretName: name });
      if (
        !secret.secretValue ||
        (expected[name] !== undefined && expected[name] !== secret.secretValue)
      )
        throw new SetupError(
          "Managed credential readback did not confirm the save. Retry safely.",
          409,
        );
      names.push(name);
    }
    if (
      Object.keys(expected).some(
        (k) => !names.includes(k as LearningSecretName),
      )
    )
      throw new SetupError(
        "Managed credential readback is incomplete. Retry safely.",
        409,
      );
    return names;
  };
  return {
    siteUrl: auth.connection.siteUrl,
    check: (s) => verify(s),
    async save(s, values) {
      const sdk = await auth.client();
      // Existing leaf scope only: managed setup never grants runner permissions.
      const existing = await sdk
        .secrets()
        .listSecrets({ ...scope(s), recursive: false, viewSecretValue: false });
      for (const [name, secretValue] of Object.entries(values)) {
        const options = { ...scope(s), secretValue };
        if (existing.secrets.some((v) => v.secretKey === name))
          await sdk.secrets().updateSecret(name, options);
        else await sdk.secrets().createSecret(name, options);
      }
      return verify(s, values);
    },
  };
}
