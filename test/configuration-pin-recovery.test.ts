import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { configurationPlan } from "../harness/megaeth/configuration-plan.ts";
import { adoptConfigurationPin } from "../harness/megaeth/configuration-pin-recovery.ts";

async function fixture() {
  const directory = await mkdtemp(
      join(tmpdir(), "pirate-configuration-pin-recovery-"),
    ),
    planned = await configurationPlan();
  const original = canonical({
    profileHash: planned.profile.pinRecovery.previousProfileHash,
    state: "running",
  });
  // Explicit HTTP receipt fixture. Production is bound to the independently
  // verified real receipt digest in the source plan, never this synthetic one.
  const body = JSON.stringify({
    Hash: planned.profile.pin.uri.slice(7),
    Size: "1135",
    Name: "fixture",
  });
  const receipt = canonical({
    profileHash: planned.profile.pinRecovery.previousProfileHash,
    status: 200,
    body,
    bodySha256: hashText(body),
    requestId: planned.profile.pinRecovery.expectedProviderRequestId,
  });
  planned.profile.pinRecovery.expectedBodySha256 = hashText(body);
  planned.profile.pinRecovery.expectedReceiptFileSha256 = hashText(receipt);
  planned.profileHash = hashJson(planned.profile);
  await writeFile(join(directory, "pin.json"), original);
  await writeFile(join(directory, "pin-receipt.json"), receipt);
  const requests: Request[] = [];
  const transport = async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    assert.ok(!url.pathname.endsWith("/add"));
    if (url.host === "rpc.filebase.io")
      return Response.json({
        Keys: { [planned.profile.pin.uri.slice(7)]: { Type: "recursive" } },
      });
    assert.equal(url.origin, "https://gateway.pinata.cloud");
    return new Response(new Uint8Array(planned.bytes));
  };
  return {
    directory,
    planned,
    original,
    receipt,
    requests,
    transport,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
test("exact pin-only adoption preserves the original proof, verifies independent bytes and cannot upload or adopt EVM work", async () => {
  const f = await fixture();
  try {
    const adopted = await adoptConfigurationPin(
      f.directory,
      f.planned,
      "fixture-token",
      f.transport,
    );
    assert.equal(adopted.profileHash, f.planned.profileHash);
    assert.equal(adopted.state, "confirmed");
    assert.equal(adopted.result.gateway, "https://gateway.pinata.cloud");
    assert.equal(
      await readFile(
        join(f.directory, "pin-before-gateway-update.json"),
        "utf8",
      ),
      f.original,
    );
    assert.equal(
      await readFile(join(f.directory, "pin-receipt.json"), "utf8"),
      f.receipt,
    );
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1); // pin/ls only
    await assert.rejects(access(join(f.directory, "evm/transactions.json")));
  } finally {
    await f.dispose();
  }
});
test("changed intent, receipt, existing EVM journal or failed read leaves the original pin journal untouched", async () => {
  for (const fault of ["intent", "receipt", "evm", "gateway"]) {
    const f = await fixture();
    try {
      if (fault === "intent") f.planned.profile.bounds.maximumTotalFee = "1";
      if (fault === "receipt")
        await writeFile(join(f.directory, "pin-receipt.json"), "{}");
      if (fault === "evm") {
        await mkdir(join(f.directory, "evm"));
        await writeFile(join(f.directory, "evm/transactions.json"), "{}");
      }
      await assert.rejects(
        adoptConfigurationPin(
          f.directory,
          f.planned,
          "fixture-token",
          fault === "gateway"
            ? async () => new Response("unavailable", { status: 503 })
            : f.transport,
        ),
      );
      assert.equal(
        await readFile(join(f.directory, "pin.json"), "utf8"),
        f.original,
      );
      await assert.rejects(
        access(join(f.directory, "pin-before-gateway-update.json")),
      );
      assert.ok(
        f.requests.every((r) => !new URL(r.url).pathname.endsWith("/add")),
      );
    } finally {
      await f.dispose();
    }
  }
});
