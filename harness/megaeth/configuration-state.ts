import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { canonical, insist } from "../../packages/community/common.ts";

export async function saveConfigurationState(
  directory: string,
  name: string,
  value: unknown,
) {
  insist(/^[a-z-]+\.json$/.test(name), "invalid_configuration_state_name");
  const file = join(directory, name),
    temporary = file + ".tmp";
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(canonical(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
