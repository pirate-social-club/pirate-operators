// Node operator/backup boundary. Do not import into browser or Worker entrypoints.
import process from "node:process";
import { Files as FilesClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { filebase } from "files-sdk/filebase";
import { backblazeB2 } from "files-sdk/backblaze-b2";
import { s3 } from "files-sdk/s3";
import { storageProfileFrom } from "../community-setup/storage.ts";

/** Resolved server-side credentials, never wizard state or a pinning token. */
export interface ObjectStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function credentialsFrom(value: unknown): ObjectStorageCredentials {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("storage_credentials_required");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => key !== "accessKeyId" && key !== "secretAccessKey",
    )
  )
    throw new Error("storage_credentials_unknown_field");
  const { accessKeyId, secretAccessKey } = input;
  for (const part of [accessKeyId, secretAccessKey]) {
    if (
      typeof part !== "string" ||
      part.trim().length === 0 ||
      part.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(part)
    )
      throw new Error("storage_credentials_invalid");
  }
  return {
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  };
}

/**
 * Construct real Files SDK adapters without environment/metadata credentials.
 * The caller owns the destination and resolves credentials in a server secret
 * scope. Call close() in finally after all Effects and body streams finish.
 * Backup callers must encrypt before upload; this factory provides transport.
 * Construction does not verify connectivity, bucket privacy or restorability.
 */
export function createObjectStorage(
  profileInput: unknown,
  credentialsInput: unknown,
) {
  if (!process.versions.node) throw new Error("storage_node_required");
  const profile = storageProfileFrom(profileInput);
  if (profile.role === "public-ipfs")
    throw new Error("storage_ipfs_requires_pinning_flow");
  const credentials = credentialsFrom(credentialsInput);
  const options = {
    bucket: profile.bucket,
    endpoint: profile.endpoint,
    region: profile.region,
    forcePathStyle: profile.forcePathStyle,
  };
  const adapter =
    profile.provider === "filebase-private"
      ? filebase({ ...options, ...credentials })
      : profile.provider === "b2"
        ? backblazeB2({ ...options, ...credentials })
        : s3({ ...options, credentials });
  // Do not enable conditional writes or public URLs by configuration. Retain
  // the SDK's conservative capability declaration for custom S3 endpoints.
  const client = new FilesClient({ adapter });
  return {
    profile,
    client,
    layer: Files.layer(client),
    close: () => client.raw.destroy(),
  };
}
