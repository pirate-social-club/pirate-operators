import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seal } from "../infra/protected-data.ts";
import { privateDirectory } from "./state.ts";

export class DeploymentFailure extends Error {
  constructor(
    readonly logId: string,
    readonly phase: string,
    readonly exitCode: number | null,
  ) {
    super(
      `Alchemy ${phase} did not complete (${exitCode ?? "could not start"}). Private encrypted diagnostics: ${logId}.`,
    );
  }
}
export async function runWithDiagnostics(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    directory: string;
    password: string;
    phase: string;
  },
) {
  const directory = join(options.directory, "diagnostics");
  await privateDirectory(directory);
  const logId = `${Date.now()}-${options.phase}-${randomUUID()}.enc`;
  const chunks: Buffer[] = [];
  let size = 0,
    truncated = false;
  const capture = (chunk: Buffer) => {
    const room = 1024 * 1024 - size;
    if (chunk.length > room) truncated = true;
    if (room > 0) {
      const part = Buffer.from(chunk.subarray(0, room));
      chunks.push(part);
      size += part.length;
    }
  };
  const result = await new Promise<{ code: number | null; started: boolean }>(
    (resolve) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", () => resolve({ code: null, started: false }));
      child.on("close", (code) => resolve({ code, started: true }));
    },
  );
  const contents = JSON.stringify({
    phase: options.phase,
    exitCode: result.code,
    started: result.started,
    truncated,
    output: Buffer.concat(chunks).toString("utf8"),
  });
  await writeFile(
    join(directory, logId),
    seal(contents, options.password, `diagnostic:${logId}`),
    { mode: 0o600, flag: "wx" },
  );
  if (result.code !== 0 || !result.started)
    throw new DeploymentFailure(logId, options.phase, result.code);
  return logId;
}
