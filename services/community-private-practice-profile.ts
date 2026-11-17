import { exact, insist, object } from "../packages/community/common.ts";

export interface PrivatePracticeScope {
  communityId: string;
  installationId: string;
  deploymentDigest: string;
}
type StudySelection = Readonly<{ kind: "private-v5"; profileHash: string }>;
type DanceSelection = Readonly<{ kind: "private-v2"; policyHash: string }>;
export interface PrivatePracticeProfile extends Readonly<PrivatePracticeScope> {
  readonly schema: "pirate.community-private-practice/1";
  readonly activities: Readonly<{
    study: StudySelection | null;
    karaoke: StudySelection | null;
    dance: DanceSelection | null;
  }>;
}
const hash = (value: unknown): string => {
  insist(
    typeof value === "string" &&
      /^0x[0-9a-f]{64}$/.test(value) &&
      !/^0x0+$/.test(value),
    "private_practice_profile_invalid",
    503,
  );
  return value;
};
function activity(
  value: unknown,
  kind: "private-v5",
  key: "profileHash",
): StudySelection | null;
function activity(
  value: unknown,
  kind: "private-v2",
  key: "policyHash",
): DanceSelection | null;
function activity(value: unknown, kind: string, key: string) {
  if (value === null) return null;
  const row = object(value);
  exact(row, ["kind", key]);
  insist(row.kind === kind, "private_practice_profile_invalid", 503);
  return Object.freeze({ kind, [key]: hash(row[key]) });
}
/** A server-owned activity selection alongside the unchanged publishing
 * deployment. It neither grants publication nor changes an owner attachment. */
export function readPrivatePracticeProfile(
  raw: string | undefined,
  scope: PrivatePracticeScope,
): PrivatePracticeProfile | null {
  if (raw === undefined) return null;
  insist(
    typeof raw === "string" && new TextEncoder().encode(raw).length <= 16384,
    "private_practice_profile_invalid",
    503,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    insist(false, "private_practice_profile_invalid", 503);
  }
  const row = object(parsed);
  exact(row, [
    "schema",
    "communityId",
    "installationId",
    "deploymentDigest",
    "activities",
  ]);
  insist(
    row.schema === "pirate.community-private-practice/1" &&
      hash(row.communityId) === hash(scope.communityId) &&
      hash(row.installationId) === hash(scope.installationId) &&
      hash(row.deploymentDigest) === hash(scope.deploymentDigest),
    "private_practice_deployment_changed",
    503,
  );
  const selected = object(row.activities);
  exact(selected, ["study", "karaoke", "dance"]);
  return Object.freeze({
    schema: "pirate.community-private-practice/1",
    ...scope,
    activities: Object.freeze({
      study: activity(selected.study, "private-v5", "profileHash"),
      karaoke: activity(selected.karaoke, "private-v5", "profileHash"),
      dance: activity(selected.dance, "private-v2", "policyHash"),
    }),
  });
}
const within = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + "/");
/** This narrows the first-song exclusions. Actual handlers retain all session,
 * runtime, media, speech and consent checks; no general feature bypass exists. */
export function privatePracticeAllows(
  profile: PrivatePracticeProfile | null,
  path: string,
): boolean {
  if (!profile) return false;
  return !!(
    (profile.activities.study &&
      ["/api/study", "/study"].some((p) => within(path, p))) ||
    (profile.activities.dance &&
      ["/api/dance", "/api/media"].some((p) => within(path, p))) ||
    (profile.activities.karaoke &&
      (["/api/karaoke", "/karaoke"].some((p) => within(path, p)) ||
        /^\/api\/public\/posts\/0x[0-9a-f]{64}\/karaoke$/.test(path)))
  );
}
