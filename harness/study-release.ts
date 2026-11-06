// Public-only preparation. There is deliberately no execution or credential path.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { studyReleasePlan } from "./study-release-profile.ts";
import { readStudyReleaseSelection } from "./study-release-input.ts";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { profile: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help || !values.profile) {
    console.log(
      "Usage: node harness/study-release.ts --profile PUBLIC_SELECTION.json\nPublic preparation only; no credentials, provider calls or deployment.",
    );
    return;
  }
  console.log(
    JSON.stringify(
      studyReleasePlan(await readStudyReleaseSelection(values.profile)),
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error("study_release_preparation_failed");
    process.exitCode = 1;
  });
