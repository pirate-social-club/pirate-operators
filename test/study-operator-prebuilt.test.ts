// Manual retained-provider proof locally; CI uses the same SDK if installed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { communityDependencyModules } from "../harness/community-dependencies.ts";
import { prepareOperatorPackage } from "../harness/study-operator-package.ts";
import {
  assertOperatorModuleClosure,
  operatorPackageFiles,
} from "../harness/study-operator-module-closure.ts";
import { digest } from "../harness/private-json.ts";
import { fixture } from "./study-operator-fixture.ts";
const retained = existsSync(
  join(communityDependencyModules, "@alchemy.run/cloudflare/package.json"),
);
const available = retained
  ? communityDependencyModules
  : existsSync(
        resolve(
          "apps/community-wizard/node_modules/@alchemy.run/cloudflare/package.json",
        ),
      )
    ? resolve("apps/community-wizard/node_modules")
    : undefined;
const skip = available
  ? false
  : "pinned Alchemy/Cloudflare SDK unavailable in this root-only CI job; retained-provider proof is a required local release gate";
const prepared = available
  ? await prepareOperatorPackage(process.cwd())
  : undefined;
async function layout(inner = false) {
  const base = await mkdtemp(join(tmpdir(), "operator-prebuilt-")),
    directory = join(base, "package");
  await mkdir(directory, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(prepared!.files))
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
  await writeFile(
    join(directory, "package-manifest.json"),
    JSON.stringify({
      schema: "pirate.study-operator-package/1",
      files: Object.fromEntries(
        Object.entries(prepared!.files).map(([n, b]) => [n, digest(b)]),
      ),
    }),
    { mode: 0o600 },
  );
  await symlink(
    available!,
    join(inner ? directory : base, "node_modules"),
    "dir",
  );
  const profile = fixture();
  profile.artifact.sha256 = prepared!.artifactSha256;
  profile.artifact.bytes = prepared!.artifactBytes;
  return {
    base,
    directory,
    profile,
    check: () =>
      assertOperatorModuleClosure(profile, directory, prepared!, available),
  };
}
test(
  "actual pinned default glob reproduces dependency closure and corrected reader selects exact one module",
  { skip },
  async () => {
    const bad = await layout(true),
      provider = join(available!, "@alchemy.run/cloudflare"),
      require = createRequire(join(provider, "package.json"));
    const { glob } = await import(
      pathToFileURL(require.resolve("tinyglobby")).href
    );
    const { defaultModuleRules } = await import(
      pathToFileURL(join(provider, "lib/Workers/Sources/Prebuilt.js")).href
    );
    const names: string[] = await glob(
      defaultModuleRules.flatMap((r: any) => r.globs),
      {
        cwd: bad.directory,
        onlyFiles: true,
        expandDirectories: false,
        dot: true,
      },
    );
    assert.ok(names.length > 1);
    assert.ok(names.some((n) => n.startsWith("node_modules/")));
    if (retained) assert.equal(names.length, 8198);
    await assert.rejects(bad.check(), /upload_directory_unclassified/);
    const good = await layout();
    const closure = await good.check();
    assert.equal(closure.modules, 1);
    assert.equal(closure.module, "operator.mjs");
    assert.equal(closure.sha256, prepared!.artifactSha256);
    assert.equal(closure.bytes, prepared!.artifactBytes);
    if (retained) {
      assert.equal(closure.bytes, 1014691);
      assert.equal(
        closure.sha256,
        "0x14909b80a34fcd75691360f59ea486813d4195fd56e2891ac3a2c820ebfda436",
      );
    }
    for (const name of operatorPackageFiles)
      assert.ok(
        (await readFile(join(good.directory, name))).equals(
          Buffer.from(prepared!.files[name]),
        ),
      );
    // A real Node import resolves the unchanged config through the ancestor link,
    // but cannot execute a CLI, network request or the returned Stack effect.
    const script = join(good.base, "import-proof.mjs");
    await writeFile(
      script,
      `import{createRequire,syncBuiltinESMExports}from'node:module';const cp=createRequire(import.meta.url)('node:child_process');for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=()=>{throw Error('child forbidden')};syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('network forbidden')};const m=await import(${JSON.stringify(pathToFileURL(join(good.directory, "learning-testnet.alchemy.ts")).href)});if(m.default.stackName!=='pirate-learning-testnet-v2')throw Error('wrong stack');console.log('ancestor config import passed; effect not run');`,
    );
    const env = {
      PATH: process.env.PATH,
      HOME: good.base,
      CI: "true",
      NO_COLOR: "1",
      ALCHEMY_TELEMETRY_DISABLED: "1",
      LEARNING_COMMUNITY_ID: good.profile.selection.communityId,
      LEARNING_RESULTS_CONTRACT: good.profile.selection.resultsV2.contract,
      LEARNING_PROFILE: "pirate-learning-testnet-v3",
      LEARNING_RESULTS_V3_CONTRACT: good.profile.selection.resultsV3.contract,
      LEARNING_GRADER_ADDRESS: "0x" + "1".repeat(40),
      LEARNING_ISSUER_ADDRESS: "0x" + "2".repeat(40),
      LEARNING_SPONSOR_CAP_WEI: "500000000000000",
      LEARNING_GAS_PRICE_WEI: "1000000",
      LEARNING_GAS_LIMIT: "1500000",
      LEARNING_DATA_FEE_WEI: "100000000000",
      LEARNING_SPEECH_DAILY_LIMIT: "0",
      LEARNING_QUOTE_VALID_FROM: "1",
      LEARNING_QUOTE_VALID_UNTIL: "2",
    };
    const output = execFileSync(
      process.execPath,
      ["--experimental-transform-types", script],
      {
        cwd: good.base,
        env,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(output, /ancestor config import passed/);
    // Hosted root-only jobs have no private retained tree. Prove that an
    // explicitly qualified SDK root is forwarded through the actual reader.
    const alternate = join(good.base, "explicit-sdk-proof.mjs");
    await writeFile(
      alternate,
      `import{readFile}from'node:fs/promises';globalThis.fetch=()=>{throw Error('network forbidden')};const{assertOperatorModuleClosure}=await import(${JSON.stringify(pathToFileURL(resolve("harness/study-operator-module-closure.ts")).href)});const files=Object.fromEntries(await Promise.all(${JSON.stringify(operatorPackageFiles)}.map(async n=>[n,await readFile(${JSON.stringify(good.directory)}+'/'+n)])));const result=await assertOperatorModuleClosure(${JSON.stringify(good.profile)},${JSON.stringify(good.directory)},{files},${JSON.stringify(available)});if(result.modules!==1)throw Error('wrong closure');console.log('explicit SDK root passed');`,
    );
    const explicit = execFileSync(
      process.execPath,
      ["--experimental-transform-types", alternate],
      {
        cwd: good.base,
        env: { PATH: process.env.PATH, HOME: good.base },
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(explicit, /explicit SDK root passed/);
  },
);
for (const extension of ["mjs", "js", "wasm", "txt"])
  test(
    `upload guard refuses unreviewed ${extension} file`,
    { skip },
    async () => {
      const f = await layout();
      await writeFile(join(f.directory, "extra." + extension), "extra", {
        mode: 0o600,
      });
      await assert.rejects(f.check(), /unclassified/);
    },
  );
test("upload guard refuses nested selected modules", { skip }, async () => {
  const f = await layout();
  await mkdir(join(f.directory, "nested"));
  await writeFile(join(f.directory, "nested/extra.mjs"), "extra");
  await assert.rejects(f.check(), /unclassified/);
});
test(
  "upload guard refuses symlinked runtime even when its bytes are exact",
  { skip },
  async () => {
    const f = await layout();
    const entry = join(f.directory, "operator.mjs");
    const { rename } = await import("node:fs/promises");
    await rename(entry, join(f.base, "saved.mjs"));
    await symlink(join(f.base, "saved.mjs"), entry);
    await assert.rejects(f.check(), /not_private_regular/);
  },
);
test("upload guard refuses mutated entry bytes", { skip }, async () => {
  const f = await layout();
  await writeFile(join(f.directory, "operator.mjs"), "changed");
  await assert.rejects(f.check(), /upload_bytes_changed/);
});
test(
  "upload guard refuses an ancestor dependency link to a different tree",
  { skip },
  async () => {
    const f = await layout();
    const { unlink } = await import("node:fs/promises");
    await unlink(join(f.base, "node_modules"));
    await mkdir(join(f.base, "other"));
    await symlink(join(f.base, "other"), join(f.base, "node_modules"));
    await assert.rejects(f.check(), /ancestor_dependencies_changed/);
  },
);
