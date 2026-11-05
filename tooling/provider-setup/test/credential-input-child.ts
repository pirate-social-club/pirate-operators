import { readSecret } from "../private-input.ts";
import { SetupFailure } from "../model.ts";
try {
  const value = await readSecret("FILEBASE_ACCESS_KEY_ID");
  if (value !== "NeverEchoThisCredential")
    throw new Error("fixture_input_mismatch");
  process.stdout.write("entry_complete\n");
} catch (error) {
  process.stdout.write(
    `entry_cancelled:${error instanceof SetupFailure ? error.code : "unknown"}\n`,
  );
}
