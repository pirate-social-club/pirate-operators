import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(
  new URL("../harness/ci/run-root-tests.mjs", import.meta.url),
);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pirate-ci-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "test"));
  return root;
}

async function invoke(root: string, shard: string | undefined) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_SHARD;
  if (shard !== undefined) env.TEST_SHARD = shard;
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr, pid: child.pid };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeCase(
  root: string,
  name: string,
  failure = false,
  gate?: string[],
) {
  await writeFile(
    join(root, "test", name),
    `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import test from 'node:test';
const name = ${JSON.stringify(name)};
const gate = ${JSON.stringify(gate ?? null)};
const mark = kind => appendFileSync('events.jsonl', JSON.stringify({name,kind,pid:process.pid})+'\\n');
test(name, async () => {
  assert.equal(globalThis.pirateSchedulingFixture, undefined);
  globalThis.pirateSchedulingFixture = name;
  mark('start');
  try {
    const deadline = Date.now()+5000;
    while (gate && !gate.every(name => readFileSync('events.jsonl','utf8').trim().split('\\n').map(JSON.parse).some(e => e.name===name && e.kind==='start'))) {
      assert.ok(Date.now()<deadline, 'two real workers must start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(${JSON.stringify(failure)}, false);
  } finally { mark('end'); }
});
`,
  );
}

test(
  "four actual shards execute every root file once, retain process isolation and report both streams",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t);
    // Independent expected inventory: two measured slow names and ten new names.
    const names = [
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
      "f.test.ts",
      "g.test.ts",
      "h.test.ts",
      "hosted-community-worker.test.ts",
      "i.test.ts",
      "j.test.ts",
      "web2-first-song.test.ts",
    ];
    const expected = [
      ["hosted-community-worker.test.ts", "a.test.ts", "e.test.ts"],
      ["b.test.ts", "f.test.ts", "i.test.ts"],
      ["c.test.ts", "g.test.ts", "j.test.ts"],
      ["web2-first-song.test.ts", "d.test.ts", "h.test.ts"],
    ];
    for (const name of names)
      await writeCase(
        root,
        name,
        false,
        expected.find((group) => group.includes(name))!.slice(0, 2),
      );
    await writeFile(
      join(root, "test", "helper.ts"),
      "throw new Error('not a test');",
    );
    await writeFile(
      join(root, "test", ".hidden.test.ts"),
      "throw new Error('hidden file excluded by original glob');",
    );
    await mkdir(join(root, "test", "nested"));
    await writeFile(
      join(root, "test", "nested", "excluded.test.ts"),
      "throw new Error('nested file excluded by original glob');",
    );
    const seen: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const result = await invoke(root, `${i}/4`);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const plan = JSON.parse(
        await readFile(
          join(root, ".local", `root-test-plan-${i}.json`),
          "utf8",
        ),
      );
      assert.deepEqual(
        plan.files,
        expected[i - 1].map((name) => `test/${name}`),
      );
      const xml = await readFile(
        join(root, ".local", `root-tests-${i}.xml`),
        "utf8",
      );
      assert.match(xml, /<\/testsuites>/);
      for (const name of expected[i - 1]) {
        assert.ok(result.stdout.includes(name), `spec missing ${name}`);
        assert.ok(xml.includes(`name="${name}"`), `JUnit missing ${name}`);
      }
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const current = events.filter((event) =>
        expected[i - 1].includes(event.name),
      );
      let active = 0,
        peak = 0;
      for (const event of current) {
        assert.notEqual(event.pid, result.pid);
        active += event.kind === "start" ? 1 : -1;
        peak = Math.max(peak, active);
        if (event.kind === "start") seen.push(event.name);
      }
      assert.equal(active, 0);
      assert.equal(peak, 2);
      assert.equal(new Set(current.map((event) => event.pid)).size, 3);
      assert.deepEqual(
        new Set(
          current
            .filter((event) => event.kind === "start")
            .slice(0, 2)
            .map((event) => event.name),
        ),
        new Set(expected[i - 1].slice(0, 2)),
      );
    }
    assert.deepEqual(seen.sort(), [...names].sort());
  },
);

test(
  "assertion and load errors fail the process while both reporters retain results",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t);
    for (const letter of "abcdefghi")
      await writeCase(root, `${letter}.test.ts`, letter === "e");
    await writeFile(
      join(root, "test", "i.test.ts"),
      "throw new Error('fixture-load-failure');",
    );
    const result = await invoke(root, "1/4");
    assert.equal(result.code, 1, result.stderr + result.stdout);
    const xml = await readFile(
      join(root, ".local", "root-tests-1.xml"),
      "utf8",
    );
    assert.match(xml, /<failure\b/);
    assert.match(xml, /<\/testsuites>/);
    assert.ok(result.stdout.includes("e.test.ts"));
    assert.ok(xml.includes("e.test.ts"));
    assert.ok(result.stdout.includes("fixture-load-failure"));
  },
);

test(
  "invalid shard, empty inventory and unwritable report cannot become green",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t);
    for (const shard of [undefined, "0/4", "5/4", "1/3", "1/4x"]) {
      assert.notEqual((await invoke(root, shard)).code, 0);
    }
    assert.notEqual((await invoke(root, "1/4")).code, 0);
    await writeCase(root, "a.test.ts");
    assert.notEqual((await invoke(root, "2/4")).code, 0);
    await mkdir(join(root, ".local", "root-tests-1.xml"), { recursive: true });
    assert.notEqual((await invoke(root, "1/4")).code, 0);
  },
);
