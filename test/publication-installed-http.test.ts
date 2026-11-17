import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../packages/protocol/index.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationSelectionHash } from "../services/publication-app-selection.ts";
import {
  installPublicationSelection,
  PublicationInstallation,
  type PublicationInstallationSpec,
} from "../services/publication-installed-selection.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
async function installed(f: Fixture) {
  const existing = Reflect.get(f.ports, "installation");
  if (existing instanceof PublicationInstallation) return existing;
  const release = f.authority.release;
  const first = await installPublicationSelection(f.ports.db, {
    schema: "pirate.publication-installation/1",
    communityId: f.context.communityId,
    installationId: release.source.installationId,
    origin: f.context.origin,
    incarnation: "1",
    installedBindingSha256: digest("installed-binding-1"),
    active: publicationSelectionHash(release),
    entries: [{ release, transportRef: "operator-primary" }],
    previous: null,
  } satisfies PublicationInstallationSpec);
  Object.assign(f.ports, { installation: first, catalog: first.catalog });
  return first;
}
async function disabled(f: Fixture, first: PublicationInstallation) {
  return installPublicationSelection(f.ports.db, {
    schema: "pirate.publication-installation/1",
    communityId: f.context.communityId,
    installationId: first.expected.installationId,
    origin: f.context.origin,
    incarnation: String(Number(first.expected.incarnation) + 1),
    installedBindingSha256: digest("installed-binding-off"),
    active: null,
    entries: [
      { release: f.authority.release, transportRef: "operator-primary" },
    ],
    previous: first.expected,
  } satisfies PublicationInstallationSpec);
}
const localHead = (f: Fixture) =>
  f.db
    .prepare(
      "SELECT generation,stopped FROM publication_v1_heads WHERE purpose='study-results'",
    )
    .first<{ generation: number; stopped: number }>();

test(
  "a stale mounted preparation cannot expose a challenge after installed selection changes during RPC",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await installed(f),
        gate = f.authority.holdRpc("eth_chainId"),
        pending = f.prepare("install-rpc-race");
      try {
        await gate.entered;
        await disabled(f, first);
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.ok(response.status >= 400, JSON.stringify(response.value));
      assert.equal(response.value.walletRequest, undefined);
      const rows = await f.rows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].typed_json, null);
      assert.equal(rows[0].signature, null);
      assert.equal(f.operatorCalls.length, 0);
    } finally {
      await f.artifact("installed-http-stale-rpc");
    }
  },
);

test(
  "installed selection changes at actual signature-accepting SQL cannot retain the first signature",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await installed(f),
        prepared = await f.prepare("install-signature-race");
      assert.equal(prepared.status, 200);
      const command = parseCommand(prepared.value.command),
        signature = await f.sign(command);
      const gate = f.holdMutation("SET phase='accepted'"),
        pending = f.submit({ commandId: command.commandId, signature });
      try {
        await gate.entered;
        await disabled(f, first);
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.ok(response.status >= 400, JSON.stringify(response.value));
      const row = (await f.rows())[0];
      assert.equal(row.phase, "prepared");
      assert.equal(row.signature, null);
      assert.equal(row.accepted_json, null);
      assert.equal(f.operatorCalls.length, 0);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("installed-http-signature-sql");
    }
  },
);

test(
  "installed selection changes at head-opening SQL keep the grant stopped while a current disabled mount recovers its receipt",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await installed(f),
        prepared = await f.prepare("install-head-race");
      assert.equal(prepared.status, 200);
      const command = parseCommand(prepared.value.command);
      assert.equal(
        (
          await f.submit({
            commandId: command.commandId,
            signature: await f.sign(command),
          })
        ).status,
        200,
      );
      const original = await f.historicalRecordedOriginal(command);
      const gate = f.holdMutation(
          "UPDATE publication_v1_heads AS h SET stopped=0",
        ),
        pending = f.call("commands/" + command.commandId);
      let off: PublicationInstallation;
      try {
        await gate.entered;
        off = await disabled(f, first);
      } finally {
        gate.release();
      }
      const stale = await pending;
      assert.ok(
        stale.status >= 400 ||
          (stale.value.currentGrant as { state: string }).state !== "allowed",
      );
      assert.deepEqual(await localHead(f), { generation: 0, stopped: 1 });
      // Rebuild the actual server dependency from its new pinned installation;
      // the retained catalogue is loaded from D1 with fresh publication disabled.
      Object.assign(f.ports, { installation: off!, catalog: off!.catalog });
      const recovered = await f.call("commands/" + command.commandId);
      assert.equal(recovered.status, 200);
      assert.equal(
        (recovered.value.receipt as { state: string }).state,
        "recorded",
      );
      assert.equal(
        (recovered.value.receipt as { transactionHash: string })
          .transactionHash,
        original.hash,
      );
      assert.notEqual(
        (recovered.value.currentGrant as { state: string }).state,
        "allowed",
      );
      assert.equal((await f.prepare("new-disabled-grant")).status, 409);
      assert.equal((await f.call("capabilities")).value.profile, "first-song");
      assert.equal(f.store().get("op:nonce"), 1);
      assert.equal(f.store().entries("tx:").length, 1);
      assert.equal(
        f.store().get<{ raw: string }>("tx:0000000000")!.raw,
        original.raw,
      );
    } finally {
      await f.artifact("installed-http-head-sql-recovery");
    }
  },
);
