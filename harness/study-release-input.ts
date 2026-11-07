import { open } from "node:fs/promises";
import { insist } from "../packages/community/common.ts";
import { studyReleaseSelection } from "./study-release-profile.ts";

export async function readStudyReleaseSelection(path: string) {
  const file = await open(path, "r"),
    raw = Buffer.alloc(65537);
  let size = 0;
  try {
    while (size < raw.length) {
      const { bytesRead } = await file.read(raw, size, raw.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } finally {
    await file.close();
  }
  insist(size <= 65536, "study_release_profile_too_large", 409);
  return studyReleaseSelection(
    JSON.parse(raw.subarray(0, size).toString("utf8")),
  );
}
