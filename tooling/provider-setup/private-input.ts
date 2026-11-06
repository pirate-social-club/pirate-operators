import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { requireThat, SetupFailure } from "./model.ts";

export function validCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\x21-\x7e]{1,16384}$/.test(value) &&
    ![
      "PENDING",
      "REPLACE_ME",
      "CHANGEME",
      "TODO",
      "PLACEHOLDER",
      "__PENDING__",
    ].includes(value.toUpperCase()) &&
    !/^<.*>$/.test(value)
  );
}

/** Readline disables terminal echo; its entire output stream is discarded.
 * Only the fixed label and final newline go to the real terminal. */
export async function readSecret(label: string): Promise<string> {
  requireThat(
    process.stdin.isTTY && process.stderr.isTTY && !process.stdin.isRaw,
    "credential_entry_requires_local_terminal",
  );
  requireThat(
    /^[A-Za-z][A-Za-z0-9 _-]{0,80}$/.test(label),
    "invalid_credential_label",
  );
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminal = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
    historySize: 0,
  });
  process.stderr.write(`${label} (paste value; input hidden): `);
  let stopped = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = () => {
        if (!stopped) {
          stopped = true;
          reject(new SetupFailure("credential_entry_cancelled"));
        }
      };
      terminal.once("SIGINT", cancel);
      terminal.once("close", cancel);
      process.once("SIGTERM", cancel);
      terminal.question("", (value) => {
        if (stopped) return;
        stopped = true;
        process.removeListener("SIGTERM", cancel);
        if (validCredential(value)) resolve(value);
        else
          reject(new SetupFailure("empty_or_placeholder_credential_refused"));
      });
      terminal.once("close", () => process.removeListener("SIGTERM", cancel));
    });
  } finally {
    stopped = true;
    terminal.close();
    sink.destroy();
    process.stderr.write("\n");
  }
}
