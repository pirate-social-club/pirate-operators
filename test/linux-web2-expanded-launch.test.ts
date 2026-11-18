import assert from "node:assert/strict";
import test from "node:test";
import { authenticateWeb2Enrollment, authenticateWeb2ExpandedEnrollment } from "../deploy/linux/web2-profile-authority.ts";
import { readWeb2Community } from "../packages/community/web2-directory-reader.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";

test("ordinary registration remains revision one and cannot satisfy the opted expansion before its own canonical transition",
  { timeout: 120000 }, async t => {
    const fixture = await installationAuthorityFixture();
    t.after(fixture.close);
    const before = await authenticateWeb2Enrollment(fixture.authority, fixture.draft);
    assert.equal(before.configurationRevision, 1);
    const genesis = await fixture.authority.client.getBlock({ blockNumber: 0n });
    assert(genesis.hash);
    await assert.rejects(authenticateWeb2ExpandedEnrollment(fixture.authority, fixture.draft, {
      original: before,
      configuration: { ...fixture.draft.configuration, configurationRevision: 2,
        learningRecords: "0x1234123412341234123412341234123412341234" },
      // Reusing the authentic revision-one transaction and block must not
      // count as the separately authorized revision-two transition.
      configurationHash: before.transactionHash, configurationBlockHash: before.registrationBlockHash,
      admittedSafeBlock: before.safeBlock, admittedSafeBlockHash: before.safeBlockHash, genesisHash: genesis.hash,
      registryRuntimeHash: before.registrationBlockHash,
    }), /install_expanded_configuration_changed/);
    const after = await authenticateWeb2Enrollment(fixture.authority, fixture.draft);
    assert.equal(after.transactionHash, before.transactionHash);
    assert.equal(after.configurationSha256, before.configurationSha256);
    assert.equal(after.configurationRevision, 1);

    // A real revision-two event for this exact registration still cannot
    // authorize expansion when it changes an unrelated configuration field.
    await fixture.chain.nextRevision();
    fixture.setNow(BigInt(Math.floor(Date.now() / 1000)));
    const current = await readWeb2Community(fixture.authority.client, fixture.chain.profile,
      { now: fixture.authority.now, maxSafeBlockAgeSeconds: fixture.authority.maxSafeBlockAgeSeconds }, fixture.authority.send);
    assert(current.configurationEvidence);
    await assert.rejects(authenticateWeb2ExpandedEnrollment(fixture.authority, fixture.draft, {
      original: before, configuration: current.config,
      configurationHash: current.configurationEvidence.log.transactionHash,
      configurationBlockHash: current.configurationEvidence.log.blockHash,
      admittedSafeBlock: String(current.blockNumber), admittedSafeBlockHash: current.blockHash, genesisHash: genesis.hash,
      registryRuntimeHash: before.registrationBlockHash,
    }), /install_expanded_configuration_changed/);
    await assert.rejects(authenticateWeb2Enrollment(fixture.authority, fixture.draft), /install_current_authority_changed/);
  });
