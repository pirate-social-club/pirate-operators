// Configuration only. Credentials and runtime acceptance are separate inputs.
export type StorageRole = "public-ipfs" | "private-objects" | "backup";
export interface PublicIpfsProfileV1 {
  version: 1;
  role: "public-ipfs";
  provider: "filebase-ipfs";
}
export interface ObjectStorageProfileV1 {
  version: 1;
  role: "private-objects" | "backup";
  provider: "filebase-private" | "b2" | "s3";
  bucket: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
}
export type StorageProfileV1 = PublicIpfsProfileV1 | ObjectStorageProfileV1;

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "storage_object_required",
  );
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
    "storage_object_required",
  );
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: string[]) {
  requireValue(
    Object.keys(input).every((key) => allowed.includes(key)),
    "storage_unknown_field",
  );
}
function text(value: unknown, pattern: RegExp, code: string): string {
  requireValue(
    typeof value === "string" && !/\s/.test(value) && pattern.test(value),
    code,
  );
  return value;
}
function endpointFrom(value: unknown): string {
  // Validate the raw form first: URL normalization must not erase a path,
  // credentials, query, fragment, backslash or whitespace.
  requireValue(
    typeof value === "string" &&
      value.length <= 512 &&
      !/\s/.test(value) &&
      /^https?:\/\/[^/?#\\\s@%]+\/?$/i.test(value),
    "storage_endpoint_invalid",
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("storage_endpoint_invalid");
  }
  requireValue(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "storage_endpoint_https_required",
  );
  return url.origin;
}

/** This selects destinations; it neither connects nor provisions them. */
export function storageProfileFrom(value: unknown): StorageProfileV1 {
  const input = object(value);
  requireValue(input.version === 1, "storage_version_invalid");
  const role = input.role;
  requireValue(
    role === "public-ipfs" || role === "private-objects" || role === "backup",
    "storage_role_invalid",
  );
  if (role === "public-ipfs") {
    keys(input, ["version", "role", "provider"]);
    const provider =
      input.provider === undefined ? "filebase-ipfs" : input.provider;
    requireValue(provider === "filebase-ipfs", "storage_pinning_required");
    // Retain the existing Filebase RPC/token and CID verification flow.
    // S3 buckets and credentials are not required by this pinning profile.
    return { version: 1, role, provider };
  }
  keys(input, [
    "version",
    "role",
    "provider",
    "bucket",
    "endpoint",
    "region",
    "forcePathStyle",
  ]);
  const provider =
    input.provider === undefined ? "filebase-private" : input.provider;
  requireValue(
    provider === "filebase-private" || provider === "b2" || provider === "s3",
    "storage_object_provider_required",
  );
  const bucket = text(
    input.bucket,
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    "storage_bucket_invalid",
  );
  requireValue(
    !bucket.includes("..") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(bucket) &&
      (provider !== "b2" || !bucket.includes(".")),
    "storage_bucket_invalid",
  );
  const region = text(
    input.region === undefined && provider === "filebase-private"
      ? "auto"
      : input.region,
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "storage_region_invalid",
  );
  if (provider === "b2")
    requireValue(
      /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{3}$/.test(region),
      "storage_b2_region_invalid",
    );
  const expectedEndpoint =
    provider === "filebase-private"
      ? "https://s3.filebase.io"
      : provider === "b2"
        ? "https://s3." + region + ".backblazeb2.com"
        : undefined;
  const endpoint = endpointFrom(
    input.endpoint === undefined ? expectedEndpoint : input.endpoint,
  );
  if (expectedEndpoint)
    requireValue(endpoint === expectedEndpoint, "storage_provider_endpoint");
  if (provider === "filebase-private")
    requireValue(region === "auto", "storage_provider_region");
  const hostname = new URL(endpoint).hostname.replace(/\.+$/, "");
  requireValue(
    hostname !== "s3.filebase.com" && !hostname.endsWith(".s3.filebase.com"),
    "storage_public_backend_for_objects",
  );
  const forcePathStyle =
    input.forcePathStyle === undefined
      ? provider === "s3" || bucket.includes(".")
      : input.forcePathStyle;
  requireValue(
    typeof forcePathStyle === "boolean",
    "storage_addressing_invalid",
  );
  requireValue(
    !bucket.includes(".") || forcePathStyle,
    "storage_dotted_bucket_requires_path_style",
  );
  return {
    version: 1,
    role,
    provider,
    bucket,
    endpoint,
    region,
    forcePathStyle,
  };
}
