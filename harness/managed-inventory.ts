import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { CommunityError, insist } from "../packages/community/common.ts";

export async function cfJson(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<unknown>((done, fail) => {
    execFile(
      resolve("node_modules/.bin/cf"),
      args,
      { env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (process.env.PIRATE_RELEASE_DEBUG === "1")
            console.error(
              JSON.stringify({
                operation: args.slice(0, 2),
                code: error.code,
                signal: error.signal,
                killed: error.killed,
                diagnostic: stderr
                  .replaceAll(
                    env.CLOUDFLARE_API_TOKEN ?? "[no token]",
                    "[redacted]",
                  )
                  .slice(0, 1200),
              }),
            );
          fail(new CommunityError("managed_inventory_failed", 503));
        } else
          try {
            done(JSON.parse(stdout));
          } catch {
            fail(new CommunityError("managed_inventory_invalid", 503));
          }
      },
    );
  });
}
export function rows(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    for (const key of ["result", "buckets", "queues"])
      if (key in input) return rows((input as Record<string, unknown>)[key]);
  }
  throw new CommunityError("managed_inventory_invalid", 503);
}
export async function managedInventory(
  env: NodeJS.ProcessEnv,
  managedPrefix: string,
) {
  const results = await Promise.all([
    cfJson(["workers", "list", "--per-page", "100", "--page", "1"], env),
    cfJson(
      ["d1", "list", "--name", `${managedPrefix}-db`, "--per-page", "100"],
      env,
    ),
    cfJson(
      [
        "r2",
        "buckets",
        "list",
        "--name-contains",
        `${managedPrefix}-media`,
        "--per-page",
        "100",
      ],
      env,
    ),
    cfJson(["queues", "list"], env),
  ]);
  const targets = [
    managedPrefix,
    `${managedPrefix}-db`,
    `${managedPrefix}-media`,
    `${managedPrefix}-jobs`,
  ];
  const found = results.map((r, index) => ({
    name: targets[index],
    present: rows(r).some((row) =>
      [row.id, row.name, row.queue_name].includes(targets[index]),
    ),
    id: rows(r)
      .filter((row) =>
        [row.id, row.name, row.queue_name].includes(targets[index]),
      )
      .map(
        (row) =>
          row[
            index === 0
              ? "id"
              : index === 1
                ? "uuid"
                : index === 2
                  ? "name"
                  : "queue_id"
          ],
      )
      .join(","),
  }));
  // A single full workers page would make absence ambiguous. Do not mutate.
  insist(
    rows(results[0]).length < 100,
    "managed_inventory_pagination_required",
    503,
  );
  return { at: new Date().toISOString(), resources: found };
}
