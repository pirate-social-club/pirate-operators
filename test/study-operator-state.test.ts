// Real pinned AES-GCM envelope and filesystem reader; every value is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../apps/community-wizard/infra/protected-data.ts";
import { authenticateOperatorFiles } from "../harness/study-operator-readonly-adapter.ts";
import { digest } from "../harness/private-json.ts";
import { fixture } from "./study-operator-fixture.ts";
const password = "synthetic-only-state-protection-password-20261107",
  relative = "pirate-learning-testnet-v2/testnet/Operator.json";
async function stateCase() {
  const profile = fixture(),
    base = await mkdtemp(join(tmpdir(), "operator-state-")),
    path = join(base, "alchemy/.alchemy/state", relative);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const attr = {
    accountId: profile.worker.accountId,
    workerId: profile.worker.tag,
    workerName: profile.worker.name,
  };
  const old = {
    status: "updated",
    resourceType: "Cloudflare.Worker",
    logicalId: "Operator",
    providerMode: "live",
    props: { name: profile.worker.name },
    bindings: [],
    attr: { ...attr },
  };
  const record: any = {
    ...old,
    status: "updating",
    props: { ...old.props },
    attr: { ...attr },
    old: structuredClone(old),
  };
  const quote = {
    validFrom: profile.retained.quoteValidFrom,
    validUntil: profile.retained.quoteValidUntil,
  };
  const q = JSON.stringify(quote);
  await writeFile(join(base, "quote-window.json"), q, { mode: 0o600 });
  profile.predecessor.quoteWindowSha256 = digest(q);
  const save = async (context = "alchemy-state:" + relative) => {
    const bytes = seal(JSON.stringify(record), password, context);
    await writeFile(path, bytes, { mode: 0o600 });
    profile.predecessor.encryptedStateFiles = { [relative]: digest(bytes) };
    return bytes;
  };
  await save();
  return {
    profile,
    base,
    path,
    record,
    save,
    run: (pw = password) => authenticateOperatorFiles(profile, pw, base),
  };
}
test("authenticated pinned ciphertext admits terminal and exact-owned updating states without rewriting", async () => {
  const f = await stateCase();
  for (const status of ["created", "updated", "updating"]) {
    f.record.status = status;
    const before = await f.save();
    await f.run();
    assert.equal(await readFile(f.path, "utf8"), before);
  }
  delete f.record.old.status;
  delete f.record.old.resourceType;
  delete f.record.old.logicalId;
  f.record.status = "updating";
  await f.save();
  await f.run();
});
test("updating refuses wrong current physical identity", async () => {
  const f = await stateCase();
  f.record.attr.workerId = "0".repeat(32);
  await f.save();
  await assert.rejects(f.run(), /owned_worker_state_changed/);
});
test("updating refuses wrong old physical identity", async () => {
  const f = await stateCase();
  f.record.old.attr.accountId = "foreign";
  await f.save();
  await assert.rejects(f.run(), /owned_worker_state_changed/);
});
test("updating refuses changed current desired target", async () => {
  const f = await stateCase();
  f.record.props.name = "foreign";
  await f.save();
  await assert.rejects(f.run(), /updating_target_changed/);
});
test("updating refuses changed old desired target", async () => {
  const f = await stateCase();
  f.record.old.props.name = "foreign";
  await f.save();
  await assert.rejects(f.run(), /updating_target_changed/);
});
test("updating refuses missing required old structure", async () => {
  for (const key of ["attr", "props", "bindings"]) {
    const f = await stateCase();
    delete f.record.old[key];
    await f.save();
    await assert.rejects(f.run());
  }
});
test("optional full old metadata cannot disguise replacement, foreign identity or local mode", async () => {
  for (const [k, value] of [
    ["resourceType", "Other"],
    ["logicalId", "Other"],
    ["status", "replacing"],
    ["providerMode", "local"],
  ]) {
    const f = await stateCase();
    f.record.old[k] = value;
    await f.save();
    await assert.rejects(f.run(), /updating_predecessor_changed/);
  }
});
test("creating, replacing, deleting and foreign top-level identities fail closed", async () => {
  for (const [k, value] of [
    ["status", "creating"],
    ["status", "replacing"],
    ["status", "deleting"],
    ["logicalId", "Other"],
    ["resourceType", "Other"],
    ["providerMode", "local"],
  ]) {
    const f = await stateCase();
    f.record[k] = value;
    await f.save();
    await assert.rejects(f.run(), /owned_worker_state_changed/);
  }
});
test("ciphertext digest, password, context and plaintext cannot bypass authenticated ownership", async () => {
  const a = await stateCase();
  await writeFile(a.path, "changed");
  await assert.rejects(a.run(), /encrypted_state_changed/);
  const b = await stateCase();
  await assert.rejects(b.run("wrong password"), /could not be authenticated/);
  const c = await stateCase();
  await c.save("wrong-context");
  await assert.rejects(c.run(), /could not be authenticated/);
  const d = await stateCase();
  const plaintext = JSON.stringify(d.record);
  await writeFile(d.path, plaintext);
  d.profile.predecessor.encryptedStateFiles[relative] = digest(plaintext);
  await assert.rejects(d.run(), /could not be authenticated/);
});
