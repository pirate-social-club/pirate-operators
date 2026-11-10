// Local, in-memory compiler. No key, RPC, artifact directory or execution state.
import { readFileSync } from "node:fs";
import solc from "solc";
import { buildSync } from "esbuild";
import { keccak256, stringToHex, type Abi, type Hex } from "viem";
import { hashJson, insist } from "../../packages/community/common.ts";
import type { CommunityArtifact } from "../compile-community.ts";

export interface StudyDeploymentArtifact extends CommunityArtifact {
  compiler: string;
  sourceHash: Hex;
  settingsHash: Hex;
  executorSourceHash: Hex;
}
/** Bind the executable's complete local static runtime graph and pinned packages.
 * Bundling is in memory; package code remains external and lockfile-bound. */
export function studyDeploymentExecutorHash() {
  const build = buildSync({
    entryPoints: ["harness/megaeth/study-deployment.ts"],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const paths = [
    ...Object.keys(build.metafile!.inputs),
    "package.json",
    "package-lock.json",
  ].sort();
  return hashJson(
    Object.fromEntries(
      paths.map((path) => [
        path,
        keccak256(new Uint8Array(readFileSync(path))),
      ]),
    ),
  );
}
export function compileStudyDeployment(
  source?: string,
  version: 3 | 4 = 3,
): StudyDeploymentArtifact {
  const name = `LearningResultsV${version}`;
  const path = `contracts/${name}.sol`;
  source ??= readFileSync(path, "utf8");
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none" },
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
        ],
      },
    },
  };
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [path]: { content: source } },
        settings,
      }),
    ),
  ) as {
    errors?: { severity: string }[];
    contracts: Record<
      string,
      Record<
        string,
        {
          abi: Abi;
          evm: {
            bytecode: { object: string };
            deployedBytecode: {
              object: string;
              immutableReferences: CommunityArtifact["immutableReferences"];
            };
          };
        }
      >
    >;
  };
  insist(
    !output.errors?.some((error) => error.severity === "error"),
    "study_deployment_compile_failed",
  );
  const value = output.contracts[path]?.[name];
  insist(
    value?.evm.bytecode.object && value.evm.deployedBytecode.object,
    "study_deployment_artifact_missing",
  );
  return {
    abi: value.abi,
    bytecode: `0x${value.evm.bytecode.object}`,
    runtime: `0x${value.evm.deployedBytecode.object}`,
    immutableReferences: value.evm.deployedBytecode.immutableReferences,
    compiler: solc.version(),
    sourceHash: keccak256(stringToHex(source)),
    settingsHash: hashJson(settings),
    executorSourceHash: studyDeploymentExecutorHash(),
  };
}
