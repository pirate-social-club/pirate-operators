import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import { insist } from "../packages/community/common.ts";
import { communityPrefix, type communityPackage } from "./community-package.ts";

/** Rebind the existing publisher without generating or rotating a credential. */
export async function bindCommunityPublisher(
  sdk: Awaited<ReturnType<ReturnType<typeof infisicalAuth>["client"]>>,
  profile: Awaited<ReturnType<typeof communityPackage>>["profile"],
  publisherKey: string,
  get: (projectId: string, path: string, name: string) => Promise<string>,
) {
  const binding = profile.credentialBinding,
    folderName = communityPrefix,
    folders = () =>
      sdk.folders().listFolders({
        projectId: binding.projectId,
        environment: "staging",
        path: "/services",
        recursive: false,
      });
  if (!(await folders()).some((f) => f.name === folderName)) {
    try {
      await sdk.folders().create({
        projectId: binding.projectId,
        environment: "staging",
        path: "/services",
        name: folderName,
      });
    } catch {
      insist(
        (await folders()).some((f) => f.name === folderName),
        "community_secret_folder_unconfirmed",
        503,
      );
    }
  }
  const names = await sdk.secrets().listSecrets({
    projectId: binding.projectId,
    environment: "staging",
    secretPath: binding.path,
    viewSecretValue: false,
    recursive: false,
    includeImports: false,
    expandSecretReferences: false,
  });
  if (!names.secrets.some((s) => s.secretKey === binding.name)) {
    try {
      await sdk.secrets().createSecret(binding.name, {
        projectId: binding.projectId,
        environment: "staging",
        secretPath: binding.path,
        secretValue: publisherKey,
      });
    } catch {
      insist(
        (await get(binding.projectId, binding.path, binding.name)) ===
          publisherKey,
        "community_publisher_binding_unconfirmed",
        503,
      );
    }
  }
  insist(
    (await get(binding.projectId, binding.path, binding.name)) === publisherKey,
    "community_publisher_binding_changed",
    409,
  );
}
