// Pure input primitives; no credentials, backend or authority effects.
export class LinuxInputError extends Error {
  declare readonly code: string;
  declare readonly correction: string;
  constructor(code: string, correction: string) {
    super(correction);
    this.code = code;
    this.correction = correction;
  }
}
export function requireLinux(
  value: unknown,
  code: string,
  correction: string,
): asserts value {
  if (!value) throw new LinuxInputError(code, correction);
}
export function record(value: unknown): Record<string, unknown> {
  requireLinux(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_object",
    "Use a supported setup document.",
  );
  const result = value as Record<string, unknown>;
  requireLinux(
    [Object.prototype, null].includes(Object.getPrototypeOf(result)),
    "invalid_object",
    "Use a supported setup document.",
  );
  return result;
}
export function fields(
  value: unknown,
  names: string[],
): Record<string, unknown> {
  const result = record(value);
  requireLinux(
    Object.keys(result).length === names.length &&
      names.every((name) => Object.hasOwn(result, name)),
    "unsupported_fields",
    "This document has missing or unsupported fields. Export a compatible profile.",
  );
  return result;
}
export function text(value: unknown, max = 200): string {
  requireLinux(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f\x7f]/.test(value),
    "invalid_text",
    "Complete the indicated field without control characters.",
  );
  return value;
}
export function reference(value: unknown): string {
  const result = text(value, 200);
  requireLinux(
    /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(result),
    "invalid_reference",
    "Select an identifier discovered by this runner.",
  );
  return result;
}
export function hash(value: unknown): string {
  requireLinux(
    typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
    "invalid_digest",
    "The backend must supply the exact content digest.",
  );
  return value;
}
export function natural(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  requireLinux(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= max,
    "invalid_limit",
    "Use a whole nonnegative number within the supported limit.",
  );
  return value;
}
export function publicOrigin(value: unknown): string {
  const result = text(value, 512);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new LinuxInputError(
      "invalid_origin",
      "Enter the application's full HTTPS address.",
    );
  }
  requireLinux(
    url.protocol === "https:" &&
      url.origin === result &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "invalid_origin",
    "Use an HTTPS origin without a path, credentials or query.",
  );
  requireLinux(
    url.hostname !== "kaya.pirate" && !url.hostname.endsWith(".kaya.pirate"),
    "excluded_origin",
    "Choose another application address; kaya.pirate is excluded.",
  );
  return result;
}
