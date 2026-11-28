import assert from "node:assert/strict";
import test from "node:test";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";

// Pre-registration installation authority: a genuine enrollment document signed
// by the controller must authorize installation before any registration receipt
// exists, and every substitution of signer, plan or expiry must be rejected.
// Real anvil chain, real EIP-712 signatures, real verifier path.
test(
  "Web2 installation authorization accepts the genuine controller enrollment before registration",
  { timeout: 120000 },
  async (t) => {
    const f = await installationAuthorityFixture();
    t.after(f.close);
    const { web2Controller, web2Owner } = await import(
      "./fixtures/web2-first-song-chain.ts"
    );
    const { hashText } = await import("../packages/community/common.ts");
    const {
      enrollmentDocument,
      enrollmentTypedData,
      parseEnrollment,
      planDocument,
    } = await import("../packages/community/hosted-enrollment.ts");
    const { authenticateWeb2InstallationAuthorization } = await import(
      "../deploy/linux/web2-profile-authority.ts"
    );

    const enrollmentId = hashText("pre-registration enrollment");
    const document = (overrides: Record<string, unknown> = {}) => ({
      schema: "pirate.hosted-enrollment/1" as const,
      id: enrollmentId,
      inviteId: null,
      allowanceId: null,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      policyHash: hashText("fixture policy"),
      noticeSha256: hashText("fixture notice"),
      plan: planDocument(f.chain.original.plan),
      ...overrides,
    });
    const draftFor = async (
      doc: unknown,
      signer: typeof web2Controller = web2Controller,
    ) => {
      const enrollment = parseEnrollment(doc);
      const controllerSignature = await signer.signTypedData(
        enrollmentTypedData(enrollment),
      );
      return {
        ...structuredClone(f.draft),
        enrollment: {
          ...structuredClone(f.draft.enrollment),
          enrollmentId,
          operations: [],
        },
        authorization: {
          enrollment: enrollmentDocument(enrollment),
          controllerSignature,
        },
      };
    };

    const genuine = await draftFor(document());
    const evidence = await authenticateWeb2InstallationAuthorization(
      f.authority,
      genuine,
    );
    assert.equal(
      evidence.schema,
      "pirate.linux-web2-installation-authorization/1",
    );
    assert.equal(evidence.enrollmentId, enrollmentId);
    assert.equal(
      evidence.controller,
      web2Controller.address.toLowerCase(),
    );
    assert.equal(
      evidence.configurationRevision,
      f.draft.configuration.configurationRevision,
    );
    assert.ok(BigInt(evidence.safeBlock) > 0n);

    // A wrong signer never authorizes, even over the genuine document.
    await assert.rejects(
      authenticateWeb2InstallationAuthorization(
        f.authority,
        await draftFor(document(), web2Owner),
      ),
      /controller_proof_invalid/,
    );
    // A genuine enrollment committing to a different configuration URI never
    // binds to this draft, even though its own plan is internally consistent.
    const { preparePin } = await import("../packages/community/ipfs.ts");
    const { prepareWeb2Registration } = await import(
      "../packages/community/web2-registration-chain.ts"
    );
    const substituted = await preparePin(
      new TextEncoder().encode("substituted configuration"),
      "application/json",
    );
    const variantPlan = prepareWeb2Registration(
      f.chain.profile,
      f.draft.configuration,
      substituted.uri,
      f.chain.original.plan.registrar,
      f.chain.original.plan.registrarRevision,
    );
    await assert.rejects(
      authenticateWeb2InstallationAuthorization(
        f.authority,
        await draftFor(document({ plan: planDocument(variantPlan) })),
      ),
      /install_enrollment_authorization_changed/,
    );
    // An expired enrollment never authorizes installation.
    await assert.rejects(
      authenticateWeb2InstallationAuthorization(
        f.authority,
        await draftFor(
          document({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
        ),
      ),
      /install_enrollment_authorization_expired/,
    );
    // Without authorization evidence a registration-less draft is refused with
    // the original error contract.
    const bare = structuredClone(genuine) as Record<string, unknown>;
    delete bare.authorization;
    await assert.rejects(
      authenticateWeb2InstallationAuthorization(f.authority, bare),
      /registration_not_confirmed/,
    );
  },
);
