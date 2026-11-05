import { constants } from "node:fs";
import { open, mkdir, lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  canonical,
  digest,
  object,
  planFrom,
  requireThat,
  SetupFailure,
  type Journal,
  type Plan,
  type Receipt,
} from "./model.ts";

async function privateDirectory(path: string) {
  requireThat(resolve(path) === path, "absolute_state_path_required");
  let parent = path;
  for (;;) {
    try {
      const info = await lstat(parent);
      requireThat(!info.isSymbolicLink(), "state_symlink_refused");
      try {
        await lstat(join(parent, ".git"));
        throw new SetupFailure("state_inside_repository");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  requireThat(
    stat.isDirectory() &&
      stat.uid === process.getuid?.() &&
      !(stat.mode & 0o077),
    "state_directory_not_private",
  );
}
export async function readPrivate(
  path: string,
  maximum = 1024 * 1024,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireThat(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        !(stat.mode & 0o077) &&
        stat.size <= maximum,
      "private_file_required",
    );
    const bytes = await handle.readFile();
    requireThat(bytes.length <= maximum, "private_file_too_large");
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function withJournal<T>(
  directory: string,
  fn: (store: Store) => Promise<T>,
): Promise<T> {
  await privateDirectory(directory);
  const lockPath = join(directory, "runner.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new SetupFailure("runner_locked_inspect_before_recovery");
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    return await fn(new Store(directory));
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export class Store {
  journal?: Journal;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async load() {
    const bytes = await readPrivate(join(this.directory, "journal.json"));
    const value = object(JSON.parse(Buffer.from(bytes).toString()));
    const plan = planFrom(value.plan),
      steps = object(value.steps);
    for (const [name, input] of Object.entries(steps)) {
      requireThat(/^[a-z][a-z0-9.-]{1,80}$/.test(name), "invalid_journal_step");
      const s = object(input);
      requireThat(
        s.state === "started" || s.state === "done",
        "invalid_journal_step",
      );
      if (s.receipt)
        for (const [key, v] of Object.entries(object(s.receipt))) {
          requireThat(
            /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) &&
              (v === null ||
                typeof v === "boolean" ||
                (typeof v === "string" && v.length <= 2048) ||
                Number.isFinite(v)),
            "invalid_receipt",
          );
        }
    }
    this.journal = { plan, steps: steps as Journal["steps"] };
    return this.journal;
  }
  async initialize(plan: Plan) {
    requireThat(!this.journal, "journal_already_loaded");
    try {
      await lstat(join(this.directory, "journal.json"));
      throw new SetupFailure("journal_already_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.journal = { plan, steps: {} };
    await this.save();
  }
  async save() {
    requireThat(this.journal, "journal_missing");
    const temp = join(this.directory, `pending-${process.pid}.json`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(canonical(this.journal) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(this.directory, "journal.json"));
    const parent = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  async note(name: string, receipt: Receipt) {
    requireThat(
      this.journal?.steps[name]?.state === "started",
      "operation_not_started",
    );
    this.journal.steps[name].receipt = receipt;
    await this.save();
  }
  async once(
    name: string,
    perform: () => Promise<Receipt>,
    recover?: (receipt?: Receipt) => Promise<Receipt>,
  ) {
    requireThat(this.journal, "journal_missing");
    const existing = this.journal.steps[name];
    if (existing?.state === "done") return existing.receipt!;
    let receipt: Receipt;
    if (existing) {
      requireThat(
        recover,
        `uncertain_${name.replaceAll(".", "_")}_inspect_before_retry`,
      );
      receipt = await recover(existing.receipt);
    } else {
      this.journal.steps[name] = { state: "started" };
      await this.save();
      receipt = await perform();
    }
    this.journal.steps[name] = { state: "done", receipt };
    await this.save();
    return receipt;
  }
  summary() {
    requireThat(this.journal, "journal_missing");
    return {
      planDigest: digest(canonical(this.journal.plan)),
      ...this.journal,
      filebaseRuntime: "not_qualified_account_keys_remain_setup_only",
    };
  }
}
