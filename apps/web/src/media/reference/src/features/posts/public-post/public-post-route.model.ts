export type DecodedPostSlug = Readonly<{ logical: string; raw: string }>;
function forbiddenLogicalSlug(value: string): boolean {
  return (
    value === "" || value === "." || value === ".." || /[%/\\?#]/u.test(value)
  );
}

/** Decode one raw URL path segment with strict escapes and strict UTF-8. */
export function decodePublicPostSlug(raw: unknown): DecodedPostSlug | null {
  if (typeof raw !== "string" || raw === "") return null;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/u.test(raw.slice(index + 1, index + 3))) return null;
    index += 2;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (forbiddenLogicalSlug(decoded)) return null;
  const logical = decoded.normalize("NFKC");
  return forbiddenLogicalSlug(logical) ? null : { logical, raw };
}
