import { exact, insist, integer, object, text } from "../community/common.ts";
import type { ProfileMutation } from "./contracts.ts";

export const mutationId = (value: unknown): string => {
  insist(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value,
      ),
    "invalid_profile_mutation",
  );
  return value;
};
const field = (value: unknown, max: number) => {
  if (value === null) return null;
  const result = text(value, max * 2);
  insist(result.length > 0 && result.trim() === result, "invalid_profile_text");
  insist(
    [...result].length <= max &&
      !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(result),
    "invalid_profile_text",
  );
  return result;
};
export function publicMediaPath(value: unknown, origin: string): string | null {
  if (value === null) return null;
  const path = text(value, 512);
  insist(
    path.startsWith("/api/public/") && !path.includes("\\"),
    "invalid_profile_media",
  );
  const url = new URL(path, origin);
  insist(
    path.startsWith("/api/public/") &&
      !path.includes("\\") &&
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === path,
    "invalid_profile_media",
  );
  return path;
}
export async function profileMutation(
  value: unknown,
  origin: string,
  media?: (path: string) => Promise<boolean>,
): Promise<ProfileMutation> {
  const body = object(value);
  exact(body, [
    "mutationId",
    "expectedRevision",
    "displayName",
    "bio",
    "avatarRef",
    "coverRef",
  ]);
  const avatarRef = publicMediaPath(body.avatarRef, origin),
    coverRef = publicMediaPath(body.coverRef, origin);
  for (const ref of [avatarRef, coverRef])
    if (ref !== null)
      insist(media && (await media(ref)), "profile_media_unavailable", 409);
  return {
    mutationId: mutationId(body.mutationId),
    expectedRevision: integer(
      body.expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ),
    displayName: field(body.displayName, 80),
    bio: field(body.bio, 2000),
    avatarRef,
    coverRef,
  };
}
