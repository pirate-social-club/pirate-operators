import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sharedDirectoryAbi } from "../../packages/community/shared-directory.ts";
import { directoryAbi } from "../../packages/community/directory-wire.ts";
import { canonical, insist, object } from "../../packages/community/common.ts";

function parameter(value: unknown, named = true): unknown {
  const p = object(value);
  insist(typeof p.type === "string" && (!named || typeof p.name === "string"), "invalid_abi_parameter");
  return { ...(named ? { name: p.name } : {}), type: p.type,
    ...(typeof p.indexed === "boolean" ? { indexed: p.indexed } : {}),
    ...(Array.isArray(p.components) ? { components: p.components.map((item) => parameter(item)) } : {}) };
}
function entry(value: unknown): string {
  const e = object(value);
  return canonical({ type: e.type, name: e.name,
    ...(e.type === "function" ? { stateMutability: e.stateMutability } : {}),
    inputs: Array.isArray(e.inputs) ? e.inputs.map((item) => parameter(item, e.type === "event")) : [],
    ...(Array.isArray(e.outputs) ? { outputs: e.outputs.map((item) => parameter(item, false)) } : {}) });
}
test("declared shared consumer ABI matches the actual compiled V2 interface, including inherited V1 read tuple", async () => {
  // Intentionally requires Root's real build. No skip or hand-generated artifact.
  const artifact = object(JSON.parse(await readFile(new URL("../../out/CommunityDirectoryV2.sol/CommunityDirectoryV2.json", import.meta.url), "utf8")));
  insist(Array.isArray(artifact.abi), "missing_compiled_directory_abi");
  const actual = new Set(artifact.abi.filter((x) => {
    const e = object(x); return e.type === "function" || e.type === "event";
  }).map(entry));
  for (const declared of sharedDirectoryAbi) assert.ok(actual.has(entry(declared)), entry(declared));
  assert.ok(actual.has(entry(directoryAbi[0])));
});
