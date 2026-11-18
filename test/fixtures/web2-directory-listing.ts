// Disposable local fixture only. The existing chain owner holds the signer.
import assert from "node:assert/strict";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  encodeFunctionData, isHex, keccak256, parseEventLogs, zeroHash,
  type Address, type Hex, type LocalAccount, type PublicClient,
} from "viem";
import { durableJson, privateJson } from "../../harness/private-json.ts";
import { canonical, hashText } from "../../packages/community/common.ts";
import { sharedBytes32 } from "../../packages/community/shared-identity.ts";
import { web2EvidenceCommitment, type Web2Evidence } from "../../packages/community/web2-address-evidence.ts";
import {
  directoryV3Abi, validateWeb2Profile, web2Binding, type Web2DirectoryProfile,
} from "../../packages/community/web2-directory.ts";

export interface LocalDirectoryListingCommand {
  communityId: Hex;
  expectedRevision: bigint;
  listed: boolean;
  reasonSha256: Hex;
}
export interface LocalWeb2ProofCommand {
  communityId: Hex;
  expectedRevision: bigint;
  proof: {
    originRevision: bigint;
    controllerRevision: bigint;
    observedAt: bigint;
    validUntil: bigint;
    evidenceSha256: Hex;
  };
}

export interface LocalWeb2ProofEvidence {
  evidence: Web2Evidence;
  /** Recheck the verifier owner's retained observation and challenge. */
  assertAuthorized(evidence: Readonly<Web2Evidence>): Promise<void>;
}

interface DirectoryContext {
  chainId: 6343;
  genesisHash: Hex;
  directory: Address;
  directoryCodeHash: Hex;
  directoryAbiSha256: Hex;
  sourceCommit: string;
  deploymentBlock: string;
  communityId: Hex;
  installationId: Hex;
  expectedRevision: string;
  data: Hex;
}
type ListingContext = DirectoryContext & {
  schema: "pirate.local-directory-listing-original/1";
  listed: boolean;
  reasonSha256: Hex;
};
type ProofContext = DirectoryContext & {
  schema: "pirate.local-directory-web2-proof-original/1";
  proof: {
    originRevision: string;
    controllerRevision: string;
    observedAt: string;
    validUntil: string;
    evidenceSha256: Hex;
  };
};
type OriginalContext = ListingContext | ProofContext;
interface Signed {
  sender: Address;
  nonce: number;
  raw: Hex;
  transactionHash: Hex;
}
export type LocalDirectoryListingOriginal = ListingContext & Signed;
export type LocalDirectoryWeb2ProofOriginal = ProofContext & Signed;

type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
type OriginalObservation<C extends OriginalContext> = {
  original: Readonly<C & Signed>;
  originalSha256: Hex;
  broadcast: "retained-unsent" | "attempted";
};
export interface LocalDirectoryListingPort {
  setListed(command: Readonly<LocalDirectoryListingCommand>): Promise<OriginalObservation<ListingContext> & { receipt: Receipt }>;
  readOriginal(command: Readonly<LocalDirectoryListingCommand>): Promise<OriginalObservation<ListingContext> | null>;
  verifyWeb2(command: Readonly<LocalWeb2ProofCommand>, admission: LocalWeb2ProofEvidence):
    Promise<OriginalObservation<ProofContext> & { receipt: Receipt }>;
  readWeb2Original(command: Readonly<LocalWeb2ProofCommand>): Promise<OriginalObservation<ProofContext> | null>;
}
type Owner = {
  client: PublicClient;
  fixtureProfile: Web2DirectoryProfile;
  signer: LocalAccount;
  genesisHash: Hex;
  assertLive(): void;
  takeListingCustody(): (outcome: "clear" | "reconcile") => void;
};

export function localDirectoryListingOwner({ client, fixtureProfile, signer, genesisHash, assertLive, takeListingCustody }: Owner) {
  const fixture = validateWeb2Profile(fixtureProfile);
  const sender = signer.address.toLowerCase() as Address;
  const gasPrice = 1_000_000n;
  return async function withDirectoryListing<T>(
    input: { journalDirectory: string; profiles: readonly Web2DirectoryProfile[] },
    run: (port: LocalDirectoryListingPort) => Promise<T>,
  ): Promise<T> {
    const journal = input.journalDirectory;
    assert.ok(isAbsolute(journal) && resolve(journal) === journal, "canonical private fixture journal path required");
    const profiles = input.profiles.map(validateWeb2Profile);
    assert.ok(profiles.length > 0 && profiles.length <= 2, "select one or two fixture installations");
    for (const profile of profiles) {
      assert.deepEqual(
        [profile.chainId, profile.directory, profile.directoryCodeHash, profile.directoryAbiSha256,
          profile.sourceCommit, profile.deploymentBlock],
        [6343, fixture.directory, fixture.directoryCodeHash, fixture.directoryAbiSha256,
          fixture.sourceCommit, fixture.deploymentBlock],
      );
    }
    assert.equal(new Set(profiles.map(p => p.communityId)).size, profiles.length);
    assert.equal(new Set(profiles.map(p => p.installationId)).size, profiles.length);
    assert.equal(fixture.chainId, 6343);
    assert.equal(client.chain?.name, "Disposable Web2 integration");
    const rpc = client.chain?.rpcUrls.default.http[0];
    assert.ok(rpc && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(rpc) && client.transport.url === rpc);

    const release = takeListingCustody();
    let openLease = true, failed = false, active: Promise<unknown> | undefined;
    const held = () => {
      assertLive();
      assert.ok(openLease, "local listing lease closed");
    };
    let completed = false;
    try {
      held();
      async function local() {
        held();
        assert.equal(await client.getChainId(), 6343);
        assert.equal((await client.getBlock({ blockNumber: 0n })).hash, genesisHash);
        held();
      }
      await local();
      // A new phase gets its own private journal. An existing path is evidence
      // for reconciliation and cannot be adopted as a fresh signing directory.
      await mkdir(journal, { mode: 0o700 });
      const parent = await open(dirname(journal), "r");
      try { await parent.sync(); } finally { await parent.close(); }

      function selected(communityId: Hex, expectedRevision: bigint) {
        const profile = profiles.find(p => p.communityId === sharedBytes32(communityId));
        assert.ok(profile, "Directory command is outside the admitted installation set");
        assert.ok(typeof expectedRevision === "bigint" && expectedRevision >= 0n && expectedRevision < (1n << 64n) - 1n);
        const source = {
          chainId: 6343 as const, genesisHash, directory: profile.directory, directoryCodeHash: profile.directoryCodeHash,
          directoryAbiSha256: profile.directoryAbiSha256, sourceCommit: profile.sourceCommit,
          deploymentBlock: String(profile.deploymentBlock), communityId: profile.communityId,
          installationId: profile.installationId, expectedRevision: String(expectedRevision),
        };
        return { profile, source };
      }
      function prepare<C extends OriginalContext>(profile: Web2DirectoryProfile, context: C, expectedRevision: bigint) {
        const name = hashText(canonical(context)).slice(2);
        Object.freeze(context);
        return { profile, context, expectedRevision, originalPath: join(journal, name + ".original.json"),
          attemptPath: join(journal, name + ".attempt.json") };
      }
      function listing(command: Readonly<LocalDirectoryListingCommand>) {
        const { communityId, expectedRevision, listed, reasonSha256 } = command;
        const { profile, source } = selected(communityId, expectedRevision);
        assert.equal(typeof listed, "boolean");
        assert.notEqual(sharedBytes32(reasonSha256), zeroHash);
        return prepare(profile, {
          ...source, schema: "pirate.local-directory-listing-original/1", listed, reasonSha256,
          data: encodeFunctionData({ abi: directoryV3Abi, functionName: "setListed",
            args: [communityId, expectedRevision, listed, reasonSha256] }),
        } satisfies ListingContext, expectedRevision);
      }
      function proofTuple(wire: ProofContext["proof"]): LocalWeb2ProofCommand["proof"] {
        return { originRevision: BigInt(wire.originRevision), controllerRevision: BigInt(wire.controllerRevision),
          observedAt: BigInt(wire.observedAt), validUntil: BigInt(wire.validUntil), evidenceSha256: wire.evidenceSha256 };
      }
      function verification(command: Readonly<LocalWeb2ProofCommand>) {
        const { communityId, expectedRevision } = command;
        const { profile, source } = selected(communityId, expectedRevision);
        const { originRevision, controllerRevision, observedAt, validUntil, evidenceSha256 } = command.proof;
        for (const n of [originRevision, controllerRevision, observedAt, validUntil])
          assert.ok(typeof n === "bigint" && n > 0n && n < (1n << 64n));
        assert.notEqual(sharedBytes32(evidenceSha256), zeroHash);
        assert.ok(validUntil > observedAt && validUntil - observedAt <= 30n * 86400n, "invalid local Web2 proof term");
        const proof = Object.freeze({
          originRevision: String(originRevision), controllerRevision: String(controllerRevision),
          observedAt: String(observedAt), validUntil: String(validUntil), evidenceSha256,
        });
        return prepare(profile, {
          ...source, schema: "pirate.local-directory-web2-proof-original/1", proof,
          data: encodeFunctionData({ abi: directoryV3Abi, functionName: "verifyWeb2",
            args: [communityId, expectedRevision, proofTuple(proof)] }),
        } satisfies ProofContext, expectedRevision);
      }
      type Prepared<C extends OriginalContext = OriginalContext> = ReturnType<typeof prepare<C>>;
      async function original<C extends OriginalContext>(p: Prepared<C>): Promise<OriginalObservation<C> | null> {
        held();
        const saved = await privateJson(p.originalPath);
        const marker = await privateJson(p.attemptPath);
        held();
        if (!saved) {
          assert.equal(marker, null, "missing original for listing attempt");
          return null;
        }
        const { raw, nonce, transactionHash } = saved;
        assert.ok(isHex(raw, { strict: true }) && isHex(transactionHash, { strict: true })
          && typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0);
        assert.equal(keccak256(raw), transactionHash);
        const entry: C & Signed = {
          ...p.context, sender, nonce, raw, transactionHash,
        };
        assert.deepEqual(saved, entry);
        const originalSha256 = hashText(canonical(entry));
        if (marker) assert.deepEqual(marker, { originalSha256, transactionHash, nonce, broadcast: "attempted" });
        return { original: Object.freeze(entry), originalSha256,
          broadcast: marker ? "attempted" : "retained-unsent" };
      }
      async function assertCurrent(p: Prepared, nonce: number, admission?: Readonly<LocalWeb2ProofEvidence>) {
        await local();
        if (admission) await admission.assertAuthorized(admission.evidence);
        const clientBlock = await client.getBlock({ blockTag: "latest" });
        assert.ok(clientBlock.hash && clientBlock.number !== null && clientBlock.number >= fixture.deploymentBlock);
        const at = { address: p.context.directory, abi: directoryV3Abi,
          blockHash: clientBlock.hash, requireCanonical: true as const } as const;
        const scoped = { ...at, args: [p.context.communityId] } as const;
        const [code, row, binding, currentNonce, pendingNonce] = await Promise.all([
          client.getCode(at), client.readContract({ ...scoped, functionName: "getCommunity" }),
          client.readContract({ ...scoped, functionName: "getBinding" }),
          client.getTransactionCount({ address: signer.address, blockTag: "latest" }),
          client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
        ]);
        assert.ok(code && keccak256(code) === p.context.directoryCodeHash);
        assert.deepEqual(binding, web2Binding(p.profile));
        assert.equal(currentNonce, nonce);
        assert.equal(pendingNonce, nonce);
        let generation: bigint | undefined;
        if (p.context.schema === "pirate.local-directory-listing-original/1") {
          const authority = await client.readContract({ ...at, functionName: "listingAuthority" });
          assert.equal(authority.toLowerCase(), sender);
          assert.equal(row.listingRevision, p.expectedRevision);
        } else {
          assert.ok(admission, "Web2 verifier evidence admission is required");
          const proof = proofTuple(p.context.proof);
          const [[verifier, currentGeneration, invalidatedAt], origin, [revision, previous]] = await Promise.all([
            client.readContract({ ...at, functionName: "getWeb2ProofAuthority" }),
            client.readContract({ ...scoped, functionName: "getOrigin" }),
            client.readContract({ ...scoped, functionName: "getWeb2Verification" }),
          ]);
          assert.equal(verifier.toLowerCase(), sender);
          assert.equal(revision, p.expectedRevision);
          assert.equal(admission.evidence.controller, row.configuration.controller.toLowerCase());
          assert.equal(origin.sha256Digest, hashText(admission.evidence.origin));
          assert.equal(proof.originRevision, origin.revision);
          assert.equal(proof.controllerRevision, origin.controllerRevision);
          assert.ok(proof.observedAt <= clientBlock.timestamp && proof.validUntil > clientBlock.timestamp
            && (revision === 0n || proof.observedAt > previous.observedAt)
            && (currentGeneration === 1n || proof.observedAt > invalidatedAt));
          generation = currentGeneration;
        }
        assert.equal((await client.getBlock({ blockNumber: clientBlock.number })).hash, clientBlock.hash);
        held();
        return { generation, listed: row.listed, listingRevision: row.listingRevision };
      }
      async function submit<C extends OriginalContext>(p: Prepared<C>, admission?: Readonly<LocalWeb2ProofEvidence>) {
        assert.equal(await original(p), null, "listing original already retained");
        const context: OriginalContext = p.context;
        const nonce = await client.getTransactionCount({ address: signer.address, blockTag: "latest" });
        const gas = await client.estimateGas({ account: signer.address, to: context.directory, data: context.data, value: 0n });
        assert.ok(gas > 0n && gas <= 1_000_000n, "local listing transaction gas bound");
        const before = await assertCurrent(p, nonce, admission);
        const raw = await signer.signTransaction({ type: "legacy", chainId: 6343, nonce, to: context.directory,
          data: context.data, value: 0n, gas, gasPrice });
        const transactionHash = keccak256(raw);
        const entry: C & Signed = {
          ...p.context, sender, nonce, raw, transactionHash,
        };
        await durableJson(p.originalPath, entry);
        const retained = await original(p);
        assert.ok(retained && retained.broadcast === "retained-unsent");
        assert.deepEqual(await assertCurrent(p, nonce, admission), before);
        await durableJson(p.attemptPath, { originalSha256: retained.originalSha256, transactionHash, nonce, broadcast: "attempted" });
        held();
        assert.equal(await client.sendRawTransaction({ serializedTransaction: raw }), transactionHash);
        const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, timeout: 8_000, retryCount: 0 });
        assert.ok(receipt.status === "success" && receipt.transactionHash === transactionHash
          && receipt.to?.toLowerCase() === context.directory && receipt.from.toLowerCase() === sender);
        const [at, tx] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }),
          client.getTransaction({ hash: transactionHash })]);
        assert.ok(at.hash === receipt.blockHash && at.transactions[receipt.transactionIndex] === transactionHash
          && tx.hash === transactionHash && tx.blockHash === at.hash && tx.blockNumber === at.number
          && tx.transactionIndex === receipt.transactionIndex && tx.from.toLowerCase() === sender
          && tx.to?.toLowerCase() === context.directory && tx.input === context.data && tx.nonce === nonce && tx.value === 0n);
        const included = receipt.logs.filter(e => e.address.toLowerCase() === context.directory
          && !e.removed && e.blockHash === at.hash && e.transactionHash === transactionHash
          && e.transactionIndex === receipt.transactionIndex);
        if (context.schema === "pirate.local-directory-listing-original/1") {
          const events = parseEventLogs({ abi: directoryV3Abi, eventName: "ListingChanged", logs: included, strict: true });
          assert.equal(events.length, 1);
          assert.deepEqual(events[0]!.args, { communityId: context.communityId, revision: p.expectedRevision + 1n,
            listed: context.listed, reasonSha256: context.reasonSha256 });
        } else {
          const events = parseEventLogs({ abi: directoryV3Abi, eventName: "Web2Verified", logs: included, strict: true });
          const generations = parseEventLogs({ abi: directoryV3Abi, eventName: "Web2ProofGenerationAccepted",
            logs: included, strict: true });
          assert.equal(events.length, 1);
          assert.equal(generations.length, 1);
          assert.equal(parseEventLogs({ abi: directoryV3Abi, eventName: "ListingChanged", logs: included, strict: true }).length, 0);
          const revision = p.expectedRevision + 1n, proof = proofTuple(context.proof);
          assert.deepEqual(events[0]!.args, { communityId: context.communityId, verificationRevision: revision, verification: proof });
          assert.deepEqual(generations[0]!.args,
            { communityId: context.communityId, verificationRevision: revision, generation: before.generation });
          const facts = { address: context.directory, abi: directoryV3Abi, args: [context.communityId],
            blockHash: receipt.blockHash, requireCanonical: true as const } as const;
          const [row, verified, proofState, generation] = await Promise.all([
            client.readContract({ ...facts, functionName: "getCommunity" }),
            client.readContract({ ...facts, functionName: "isWeb2Verified" }),
            client.readContract({ ...facts, functionName: "getWeb2Verification" }),
            client.readContract({ ...facts, functionName: "getWeb2ProofGeneration" }),
          ]);
          assert.deepEqual(proofState, [revision, proof]);
          assert.equal(generation, before.generation);
          assert.equal(verified, true);
          assert.equal(row.listed, before.listed);
          assert.equal(row.listingRevision, before.listingRevision);
        }
        assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, at.hash);
        await local();
        const observed = await original(p);
        assert.ok(observed?.broadcast === "attempted" && observed.originalSha256 === retained.originalSha256);
        await durableJson(join(journal, transactionHash.slice(2) + ".receipt.json"),
          JSON.parse(JSON.stringify(receipt, (_name, value) => typeof value === "bigint" ? String(value) : value)));
        return { ...observed, receipt };
      }
      function exclusive<T>(work: () => Promise<T>): Promise<T> {
        held();
        assert.ok(!failed && !active, "local Directory writer busy or held for reconciliation");
        const running = work().catch(error => { failed = true; throw error; });
        active = running;
        return running.finally(() => { if (active === running) active = undefined; });
      }
      const result = await run({
        setListed(command) {
          const p = listing(command);
          return exclusive(() => submit(p));
        },
        readOriginal(command) { return original(listing(command)); },
        verifyWeb2(command, admission) {
          const p = verification(command);
          const committed = web2EvidenceCommitment(p.profile, admission.evidence);
          const { sha256, evidence } = committed, proof = p.context.proof;
          assert.deepEqual([sha256, evidence.originRevision, evidence.controllerRevision, evidence.observedAt],
            [proof.evidenceSha256, proof.originRevision, proof.controllerRevision, proof.observedAt]);
          const verify = admission.assertAuthorized.bind(admission);
          return exclusive(() => submit(p, Object.freeze({ evidence, assertAuthorized: verify })));
        },
        readWeb2Original(command) { return original(verification(command)); },
      });
      assert.ok(!failed && !active, "listing phase requires reconciliation");
      completed = true;
      return result;
    } finally {
      openLease = false;
      if (active) await active.catch(() => undefined);
      release(completed ? "clear" : "reconcile");
    }
  };
}
