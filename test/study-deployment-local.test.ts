// Actual V3 bytecode and signed transactions on loopback Anvil. Only predecessor
// directory/V2 identity, IPFS transport and the L1 data-fee oracle are simulated.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  type Hex,
  type PublicClient,
} from "viem";
import { studyDeploymentFixture } from "./study-deployment-fixture.ts";
import { studyDeploymentPlan } from "../harness/megaeth/study-deployment-plan.ts";
import { runStudyDeploymentOperation } from "../harness/megaeth/study-deployment-runner.ts";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import {
  registerControllerOperation,
  markControllerOperationPrepared,
} from "../harness/megaeth/controller-dispatch-catalog.ts";
import { runtimeMatches } from "../harness/compile-community.ts";

for (const version of [3, 4] as const)
  test(`actual local V${version} constructor, both graders and prospective policies use one canonical nonce per reviewed step`, async () => {
    const f = await studyDeploymentFixture(version);
    const port = 19941 + version,
      url = `http://127.0.0.1:${port}`;
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "6343",
        "--timestamp",
        "1800000000",
        "--block-base-fee-per-gas",
        "0",
        "--silent",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    const actual = createPublicClient({
      transport: http(url, { retryCount: 0 }),
    });
    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const result = (await response.json()) as {
        result?: unknown;
        error?: unknown;
      };
      if (result.error) throw Error(JSON.stringify(result.error));
      return result.result;
    };
    let lease: ActivationJournal | undefined;
    const sends: Hex[] = [];
    try {
      for (let i = 0; ; i++) {
        if (child.exitCode !== null) throw Error(stderr);
        try {
          assert.equal(await actual.getChainId(), 6343);
          break;
        } catch (error) {
          if (i > 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      await rpc("anvil_setBalance", [
        f.profile.controller,
        "0x3635c9adc5dea00000",
      ]);
      await rpc("anvil_setNonce", [f.profile.controller, "0x18"]);
      assert.equal(
        await actual.sendRawTransaction({ serializedTransaction: f.oldRaw }),
        f.oldHash,
      );
      await actual.waitForTransactionReceipt({ hash: f.oldHash });
      await rpc("anvil_mine", ["0xc"]);
      const client = {
        ...actual,
        getCode: async (args: { address: string; blockNumber?: bigint }) =>
          [f.profile.directory, f.profile.resultsV2.contract].some(
            (address) => address.toLowerCase() === args.address.toLowerCase(),
          )
            ? "0x6000"
            : actual.getCode(args as Parameters<typeof actual.getCode>[0]),
        readContract: async (
          args: Parameters<typeof actual.readContract>[0],
        ) =>
          args.address?.toLowerCase() === f.profile.directory.toLowerCase()
            ? {
                registry: f.profile.registry,
                configurationRevision: BigInt(f.profile.configurationRevision),
                configuration: {
                  controller: f.profile.controller,
                  learningRecords: f.profile.resultsV2.contract,
                },
              }
            : actual.readContract(args),
        getGasPrice: async () => 2n,
        call: async (args: Parameters<typeof actual.call>[0]) =>
          args.to?.toLowerCase() ===
          "0x420000000000000000000000000000000000000f"
            ? { data: encodeAbiParameters([{ type: "uint256" }], [1n]) }
            : actual.call(args),
        sendRawTransaction: async ({
          serializedTransaction,
        }: {
          serializedTransaction: Hex;
        }) => {
          sends.push(serializedTransaction);
          const hash = await actual.sendRawTransaction({
            serializedTransaction,
          });
          await actual.waitForTransactionReceipt({ hash });
          await rpc("anvil_mine", ["0xc"]);
          return hash;
        },
      } as unknown as PublicClient;
      lease = new ActivationJournal(
        join(f.directory, "dispatch-custody.sqlite"),
      );
      const plan = studyDeploymentPlan(f.profile, f.artifact);
      for (const operation of plan.operations) {
        const path = join(
          f.directory,
          operation.profileHash.slice(2) + ".sqlite",
        );
        await registerControllerOperation(client, operation, lease, path);
        const journal = new ActivationJournal(path);
        try {
          assert.equal(
            (
              await runStudyDeploymentOperation(
                client,
                f.profile,
                f.artifact,
                operation,
                journal,
                f.loadKey,
                (stored) =>
                  markControllerOperationPrepared(
                    lease!,
                    path,
                    stored,
                    "deployment",
                  ),
                () => Date.now(),
                f.transport,
              )
            ).state,
            "confirmed",
          );
        } finally {
          journal.close();
        }
      }
      const read = (functionName: string, args: readonly unknown[] = []) =>
        actual.readContract({
          address: f.profile.contract,
          abi: f.artifact.abi,
          functionName,
          args,
        });
      assert.equal(await read("VERSION"), version);
      if (version === 4)
        assert.equal(await read("communityOrigin"), f.profile.communityOrigin);
      assert.equal(
        String(await read("controller")).toLowerCase(),
        f.profile.controller.toLowerCase(),
      );
      assert.equal(await read("communityId"), f.profile.communityId);
      assert.equal(await read("publicityPolicy"), f.profile.publicityPolicy);
      for (const activity of [1, 2])
        assert.equal(await read("graders", [f.profile.grader, activity]), true);
      assert.equal(
        await read("policyFor", [1, 100n]),
        f.profile.policies.karaoke.sha256,
      );
      assert.equal(
        await read("policyFor", [2, 100n]),
        f.profile.policies.study.sha256,
      );
      assert.equal(
        await actual.getTransactionCount({ address: f.profile.controller }),
        30,
      );
      assert.equal(sends.length, 5);
      assert.equal(f.state.keyReads, 5);
      const code = (await actual.getCode({ address: f.profile.contract }))!;
      assert(runtimeMatches(code, f.artifact));
      assert.notEqual(keccak256(code), keccak256("0x"));
    } finally {
      lease?.close();
      child.kill();
    }
  });
