import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, type Vault } from "../model.ts";
import { Store } from "../journal.ts";

export const profile = {
  slug: "onboarding-test",
  vault: {
    projectId: "00000000-0000-0000-0000-000000000001",
    environment: "dev",
    bootstrapPath: "/onboarding/bootstrap",
    runtimePath: "/onboarding/runtime",
  },
  acrRegion: "eu-west-1",
  openaiOrganization: "org-test",
};
export const intent = "12345678-1234-4234-8234-123456789012";
export function memoryVault(): Vault & {
  bootstrap: Map<string, string>;
  runtime: Map<string, string>;
} {
  const bootstrap = new Map<string, string>(),
    runtime = new Map<string, string>();
  return {
    bootstrap,
    runtime,
    async get(zone, key) {
      return (zone === "bootstrap" ? bootstrap : runtime).get(key);
    },
    async put(key, value) {
      assert(!runtime.has(key) || runtime.get(key) === value);
      runtime.set(key, value);
    },
  };
}
export async function state() {
  const directory = await mkdtemp(join(tmpdir(), "provider-setup-test-"));
  const store = new Store(directory);
  await store.initialize(createPlan(profile, intent));
  return store;
}
