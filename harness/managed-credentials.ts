import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import { insist } from "../packages/community/common.ts";
import type { managedPackage } from "./managed-package.ts";

/** Rebind existing staging credentials; never generate, rotate or print them. */
export async function readManagedCredentials(
  profile: Awaited<ReturnType<typeof managedPackage>>["profile"],
  get: (projectId: string, path: string, name: string) => Promise<string>,
) {
  const credentials = profile.providerCredentials;
  const file = join(
      homedir(),
      ".config/pirate-operators/megaeth-testnet/keys.json",
    ),
    metadata = await lstat(file);
  insist(
    metadata.isFile() &&
      !(metadata.mode & 0o077) &&
      metadata.uid === process.getuid!(),
    "managed_signer_file_not_private",
  );
  const bytes = await readFile(file);
  // The same keys file supplies the moderation signer; a publishing profile
  // records its digest as signerSource.
  const source = (profile.signerSource ?? profile.registrationCredential) as {
    sha256: string;
  };
  insist(
    sha256(new Uint8Array(bytes)) === source.sha256,
    "managed_registration_source_file_changed",
    409,
  );
  const keys = JSON.parse(bytes.toString("utf8"));
  insist(
    keys.chainId === 6343 &&
      privateKeyToAccount(keys.keys.purchaseSigner).address.toLowerCase() ===
        profile.moderationSigner,
    "managed_signer_identity_mismatch",
  );
  const secrets: Record<string, string> = {
    MODERATION_SIGNER_PRIVATE_KEY: keys.keys.purchaseSigner,
  };
  for (const name of [
    "ACRCLOUD_ACCESS_KEY",
    "ACRCLOUD_ACCESS_SECRET",
    "OPENAI_API_KEY",
  ])
    secrets[name] = await get(
      credentials.projectId,
      credentials.sourcePath,
      name,
    );
  secrets.FILEBASE_IPFS_TOKEN = await get(
    credentials.projectId,
    credentials.sourcePath,
    "FILEBASE_IPFS_TOKEN",
  );
  // Owner publishing needs no registration operator key.
  if (profile.secretNames.includes("REGISTRATION_OPERATOR_PRIVATE_KEY")) {
    secrets.REGISTRATION_OPERATOR_PRIVATE_KEY = keys.keys.communityAdmin;
    insist(
      privateKeyToAccount(
        secrets.REGISTRATION_OPERATOR_PRIVATE_KEY as `0x${string}`,
      ).address.toLowerCase() === profile.releaseGrant.registration.operator,
      "managed_registration_operator_changed",
      409,
    );
  }
  return secrets;
}
export async function bindManagedCredentials(
  sdk: Awaited<ReturnType<ReturnType<typeof infisicalAuth>["client"]>>,
  profile: Awaited<ReturnType<typeof managedPackage>>["profile"],
  get: (projectId: string, path: string, name: string) => Promise<string>,
) {
  const credentials = profile.providerCredentials,
    managedPrefix = profile.prefix;
  const secrets = await readManagedCredentials(profile, get);
  const parent = "/services",
    folderName = managedPrefix;
  const listFolders = () =>
    sdk.folders().listFolders({
      projectId: credentials.projectId,
      environment: "staging",
      path: parent,
      recursive: false,
    });
  if (!(await listFolders()).some((f) => f.name === folderName)) {
    try {
      await sdk.folders().create({
        projectId: credentials.projectId,
        environment: "staging",
        path: parent,
        name: folderName,
      });
    } catch {
      insist(
        (await listFolders()).some((f) => f.name === folderName),
        "managed_credential_folder_unconfirmed",
        503,
      );
    }
  }
  const names = await sdk.secrets().listSecrets({
    projectId: credentials.projectId,
    environment: "staging",
    secretPath: credentials.targetPath,
    viewSecretValue: false,
    recursive: false,
    includeImports: false,
    expandSecretReferences: false,
  });
  for (const [name, secretValue] of Object.entries(secrets)) {
    if (names.secrets.some((s) => s.secretKey === name))
      insist(
        (await get(credentials.projectId, credentials.targetPath, name)) ===
          secretValue,
        "managed_credential_binding_changed",
        409,
      );
    else {
      try {
        await sdk.secrets().createSecret(name, {
          projectId: credentials.projectId,
          environment: "staging",
          secretPath: credentials.targetPath,
          secretValue,
        });
      } catch {
        insist(
          (await get(credentials.projectId, credentials.targetPath, name)) ===
            secretValue,
          "managed_credential_binding_unconfirmed",
          503,
        );
      }
    }
    insist(
      (await get(credentials.projectId, credentials.targetPath, name)) ===
        secretValue,
      "managed_credential_binding_unconfirmed",
      503,
    );
  }
  return secrets;
}
