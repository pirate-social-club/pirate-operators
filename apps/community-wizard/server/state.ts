import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { initialState, type SetupState } from "./model.ts";

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory())
    throw new Error("State path must be a real directory.");
  await chmod(path, 0o700);
}
export async function loadState(directory: string): Promise<SetupState> {
  await privateDirectory(directory);
  let state: SetupState;
  try {
    state = JSON.parse(await readFile(join(directory, "setup.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return initialState();
    throw error;
  }
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    !Array.isArray(state.secrets)
  )
    throw new Error("Unsupported setup state. Preserve it before migration.");
  if (state.deployment === "running") {
    state.deployment = "interrupted";
    state.message =
      "The runner stopped during deployment. Review and retry with the same resources; Alchemy reconciles its saved state.";
  }
  return state;
}
export async function saveState(directory: string, state: SetupState) {
  const temporary = join(directory, "setup.json.tmp");
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
    flag: "w",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, join(directory, "setup.json"));
}
