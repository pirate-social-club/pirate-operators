import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { credentialTarget, prepareCredentials } from "../credentials.ts";
import { validCredential, readSecret } from "../private-input.ts";
import { main } from "../run.ts";
import { Context } from "../http.ts";
import { state, memoryVault } from "./provider-setup-fixtures.ts";

const options = {
  "--provider": "filebase",
  "--project-id": "00000000-0000-0000-0000-000000000001",
  "--environment": "staging",
  "--bootstrap-path": "/onboarding/rehearsal/bootstrap",
};
function fakeSdk() {
  const folders = new Set<string>(),
    values = new Map<string, string>(),
    writes: string[] = [],
    scopes: Record<string, unknown>[] = [];
  let uncertain = false;
  const sdk = {
    folders: () => ({
      listFolders: async (s: Record<string, unknown>) =>
        [...folders]
          .filter(
            (path) =>
              path.substring(0, path.lastIndexOf("/")) ===
              (s.path === "/" ? "" : s.path),
          )
          .map((path) => ({ name: path.split("/").pop() })),
      create: async (s: Record<string, unknown>) => {
        folders.add(`${s.path === "/" ? "" : s.path}/${s.name}`);
      },
    }),
    secrets: () => ({
      listSecrets: async (s: Record<string, unknown>) => {
        scopes.push(s);
        return {
          secrets: [...values.keys()].map((secretKey) => ({ secretKey })),
        };
      },
      getSecret: async (s: Record<string, unknown>) => {
        scopes.push(s);
        return { secretValue: values.get(String(s.secretName)) };
      },
      createSecret: async (name: string, s: Record<string, unknown>) => {
        assert(!values.has(name));
        values.set(name, String(s.secretValue));
        writes.push(name);
        if (uncertain) throw Error("private error body");
      },
      updateSecret: async (name: string, s: Record<string, unknown>) => {
        values.set(name, String(s.secretValue));
        writes.push(name);
      },
    }),
  } as unknown as Parameters<typeof prepareCredentials>[1];
  return {
    sdk,
    folders,
    values,
    writes,
    scopes,
    loseResponses() {
      uncertain = true;
    },
  };
}
test("credential command plans without login, input or vault writes and refuses non-TTY execution", async () => {
  const args = Object.entries(options).flat();
  const planned = await main(["credentials", ...args]);
  assert.equal(planned.execution, "none");
  assert.deepEqual(planned.names, [
    "FILEBASE_ACCESS_KEY_ID",
    "FILEBASE_SECRET_ACCESS_KEY",
  ]);
  await assert.rejects(
    main(["credentials", ...args, "--execute"]),
    /requires_local_terminal/,
  );
  assert.throws(() =>
    credentialTarget({
      ...options,
      "--bootstrap-path": "/onboarding/../other",
    }),
  );
  assert.throws(() =>
    credentialTarget({ ...options, "--provider": "toString" }),
  );
});
test("credential preparation creates folders and prompts both values before any write; output contains no values", async () => {
  const f = fakeSdk(),
    prompts: string[] = [];
  const receipt = await prepareCredentials(
    credentialTarget(options),
    f.sdk,
    async (name) => {
      assert.equal(f.writes.length, 0);
      prompts.push(name);
      return `private-value-for-${name}`;
    },
  );
  assert.deepEqual(prompts, [
    "FILEBASE_ACCESS_KEY_ID",
    "FILEBASE_SECRET_ACCESS_KEY",
  ]);
  assert.equal(f.folders.has("/onboarding/rehearsal/bootstrap"), true);
  assert.equal(f.writes.length, 2);
  assert(!JSON.stringify(receipt).includes("private-value-for"));
  assert(
    f.scopes.every(
      (s) =>
        s.projectId === options["--project-id"] &&
        s.environment === "staging" &&
        s.secretPath === options["--bootstrap-path"] &&
        s.includeImports === false &&
        s.expandSecretReferences === false,
    ),
  );
  assert.equal(receipt.providerRequests, 0);
});
test("cancelling the second prompt writes neither credential", async () => {
  const f = fakeSdk();
  let inputs = 0;
  await assert.rejects(
    prepareCredentials(credentialTarget(options), f.sdk, async () => {
      if (++inputs === 2) throw Error("cancelled");
      return "first-private-value";
    }),
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.values.size, 0);
});
test("existing credentials are retained; partial pairs and placeholder replacement require explicit intent", async () => {
  const f = fakeSdk();
  f.values.set("FILEBASE_ACCESS_KEY_ID", "existing-access");
  f.values.set("FILEBASE_SECRET_ACCESS_KEY", "existing-secret");
  const retained = await prepareCredentials(
    credentialTarget(options),
    f.sdk,
    async () => {
      throw Error("must not prompt");
    },
  );
  assert.equal(retained.kept.length, 2);
  assert.equal(f.writes.length, 0);
  f.values.delete("FILEBASE_SECRET_ACCESS_KEY");
  await assert.rejects(
    prepareCredentials(credentialTarget(options), f.sdk),
    /partial_filebase_pair/,
  );
  f.values.set("FILEBASE_SECRET_ACCESS_KEY", "__PENDING__");
  await assert.rejects(
    prepareCredentials(credentialTarget(options), f.sdk),
    /placeholder_requires_explicit_replace/,
  );
  await prepareCredentials(
    credentialTarget(options),
    f.sdk,
    async (name) => `new-private-${name}`,
    true,
  );
  assert.equal(f.writes.length, 2);
});
test("uncertain credential writes require exact vault readback and placeholders never become provider requests", async () => {
  const f = fakeSdk();
  f.loseResponses();
  await prepareCredentials(
    credentialTarget(options),
    f.sdk,
    async (name) => `private-${name}`,
  );
  assert.equal(f.values.size, 2);
  const store = await state(),
    vault = memoryVault();
  vault.bootstrap.set("FILEBASE_ACCESS_KEY_ID", "PENDING");
  const ctx = new Context(store, vault, async () => {
    throw Error("must not send");
  });
  await assert.rejects(
    ctx.secret("bootstrap", "FILEBASE_ACCESS_KEY_ID"),
    /missing_filebase/,
  );
  for (const value of [
    "",
    "PENDING",
    "REPLACE_ME",
    "<key>",
    "with spaces",
    "line\nbreak",
  ])
    assert.equal(validCredential(value), false);
  await assert.rejects(
    readSecret("FILEBASE_ACCESS_KEY_ID"),
    /requires_local_terminal/,
  );
});
test("actual pseudo-terminal input is hidden, supports backspace and restores echo after success or cancellation", async () => {
  const script = String.raw`
import os,pty,select,subprocess,sys,time,termios
for cancel in (False,True):
 master,slave=pty.openpty()
 child=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,close_fds=True,env={**os.environ,'TERM':'xterm-256color'})
 transcript=b''
 deadline=time.monotonic()+10
 while b'input hidden' not in transcript:
  assert time.monotonic()<deadline,'prompt timeout'
  if select.select([master],[],[],0.1)[0]:transcript+=os.read(master,4096)
 os.write(master,b'NeverEchoThisCredential'+(b'' if cancel else b'X'))
 time.sleep(0.1)
 os.write(master,bytes([3] if cancel else [127]))
 if not cancel:
  time.sleep(0.1)
  os.write(master,bytes([13]))
 while child.poll() is None:
  assert time.monotonic()<deadline,'child timeout'
  if select.select([master],[],[],0.1)[0]:transcript+=os.read(master,4096)
 while select.select([master],[],[],0)[0]:transcript+=os.read(master,4096)
 assert b'NeverEcho' not in transcript,repr(transcript)
 assert (b'entry_cancelled' if cancel else b'entry_complete') in transcript,repr(transcript)
 assert termios.tcgetattr(slave)[3]&termios.ECHO,'terminal echo not restored'
 os.close(master);os.close(slave)
print('hidden_terminal_passed')
`;
  const result = await promisify(execFile)(
    "python3",
    [
      "-c",
      script,
      process.execPath,
      new URL("./credential-input-child.ts", import.meta.url).pathname,
    ],
    { timeout: 30000 },
  );
  assert.equal(result.stdout.trim(), "hidden_terminal_passed");
});
