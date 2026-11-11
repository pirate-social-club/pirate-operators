// Contract row D1: two clean builds of one committed tree must produce the
// same release manifest, CAR bytes and root CID.
//
// Usage: node scripts/reproducible.ts [commit]   (default HEAD)
// Each build runs in its own temporary directory from `git archive`, with
// root and web `npm ci` from committed lockfiles, so untracked files and
// the local node_modules cannot influence the result. Needs registry access
// (or a warm npm cache) for the locked installs in each build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const run = (
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 << 20,
  }).trim();
const repo = run("git", ["rev-parse", "--show-toplevel"], app);
const commit = run(
  "git",
  ["rev-parse", `${process.argv[2] ?? "HEAD"}^{commit}`],
  repo,
);
const prefix = run("git", ["rev-parse", "--show-prefix"], app).replace(
  /\/$/,
  "",
);

interface Result {
  rootCid: string;
  carSha256: string;
  releaseSha256: string;
  snapshotSha256: string;
  initialJsGzipBytes: number;
}
const results: Result[] = [];
for (const attempt of [1, 2]) {
  const dir = await mkdtemp(join(tmpdir(), `web-repro-${attempt}-`));
  try {
    execFileSync("sh", [
      "-c",
      `git -C "$0" archive "$1" | tar -x -C "$2"`,
      repo,
      commit,
      dir,
    ]);
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    const cwd = join(dir, prefix);
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd);
    run("node", ["scripts/build.ts"], cwd, {
      ...process.env,
      SOURCE_COMMIT: commit,
    });
    const sha = async (path: string) =>
      createHash("sha256")
        .update(await readFile(join(cwd, path)))
        .digest("hex");
    const car = JSON.parse(
      await readFile(join(cwd, "dist/car/car.json"), "utf8"),
    ) as { rootCid: string; carSha256: string };
    const budget = JSON.parse(
      await readFile(join(cwd, "dist/budget.json"), "utf8"),
    ) as { totalGzipBytes: number };
    results.push({
      rootCid: car.rootCid,
      carSha256: car.carSha256,
      releaseSha256: await sha("dist/site/app/release.json"),
      snapshotSha256: await sha("dist/site/public/snapshot.json"),
      initialJsGzipBytes: budget.totalGzipBytes,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const same = JSON.stringify(results[0]) === JSON.stringify(results[1]);
console.log(
  JSON.stringify({ commit, reproducible: same, builds: results }, null, 2),
);
if (!same) process.exit(1);
