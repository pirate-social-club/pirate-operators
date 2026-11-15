import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  decodeAbiParameters,
  parseAbiParameters,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";

// This generator consumes real `forge build --offline --ast` output. It never
// invokes a compiler, downloads tools, or fills missing ABI/AST with constants.
type Parameter = {
  name: string;
  type: string;
  components?: Parameter[];
  indexed?: boolean;
};
type Entry = {
  type: string;
  name?: string;
  inputs?: Parameter[];
  outputs?: Parameter[];
  stateMutability?: string;
  anonymous?: boolean;
};
type Ast = {
  id: number;
  nodeType: string;
  name?: string;
  nodes?: Ast[];
  members?: Ast[];
  typeName?: Ast;
  referencedDeclaration?: number;
};
function verifyMetadata(
  artifact: { rawMetadata: string },
  source: string,
  name: string,
) {
  const metadata = JSON.parse(artifact.rawMetadata);
  if (
    metadata.compiler.version !== "0.8.30+commit.73712a01" ||
    metadata.settings.compilationTarget[source] !== name
  )
    throw Error("wrong_consent_metadata_target");
  for (const [path, pin] of Object.entries(metadata.sources) as [
    string,
    { keccak256: string },
  ][]) {
    if (keccak256(readFileSync(path)) !== pin.keccak256)
      throw Error(`stale_compiler_source:${path}`);
  }
  return metadata;
}
function load(name: string, source: string, ir: boolean, runs: number) {
  const artifact = JSON.parse(
    readFileSync(`out/${name}.sol/${name}.json`, "utf8"),
  );
  const metadata = verifyMetadata(artifact, source, name);
  const s = metadata.settings;
  if (
    s.evmVersion !== "cancun" ||
    s.optimizer.enabled !== true ||
    s.optimizer.runs !== runs ||
    (s.viaIR ?? false) !== ir
  )
    throw Error("wrong_consent_build_profile");
  const runtime: string = artifact.deployedBytecode.object;
  if (
    !/^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(runtime) ||
    (runtime.length - 2) / 2 > 24576
  )
    throw Error("invalid_consent_runtime");
  const abi: Entry[] = artifact.abi;
  if (!Array.isArray(abi)) throw Error("missing_abi");
  const sha = (v: unknown) =>
    `0x${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`;
  const profile = {
    schema: "pirate.publication-build/1",
    contract: name,
    compiler: metadata.compiler.version,
    evmVersion: s.evmVersion,
    optimizerRuns: runs,
    viaIR: ir,
    abiSha256: sha(abi),
    runtimeTemplateHash: keccak256(runtime as Hex),
    runtimeBytes: (runtime.length - 2) / 2,
    immutableReferences: artifact.deployedBytecode.immutableReferences ?? {},
    sources: metadata.sources,
  };
  return { artifact, abi, profile, runtime };
}
const generated =
  "// Generated from actual solc ABI/AST by harness/megaeth/generate-publication-consent.ts.\n";
function emit(path: string, values: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    generated +
      Object.entries(values)
        .map(
          ([name, value]) =>
            `export const ${name} = ${JSON.stringify(value, null, 2)} as const;\n`,
        )
        .join(""),
  );
}
export function generatePublicationConsent() {
  const learning = load(
    "LearningResultsV5",
    "contracts/LearningResultsV5.sol",
    false,
    200,
  );
  const dance = load(
    "DanceVerdictsV2",
    "contracts/dance/DanceVerdictsV2.sol",
    true,
    1,
  );
  const capture = load(
    "DanceCapturePolicyV2",
    "contracts/dance/DanceCapturePolicyV2.sol",
    true,
    1,
  );
  const intf = JSON.parse(
    readFileSync(
      "out/ICommunityPublicationConsentV1.sol/ICommunityPublicationConsentV1.json",
      "utf8",
    ),
  );
  verifyMetadata(
    intf,
    "contracts/interfaces/community/ICommunityPublicationConsentV1.sol",
    "ICommunityPublicationConsentV1",
  );
  function parameterShape(p: Parameter, member = false): unknown {
    return {
      type: p.type,
      indexed: p.indexed,
      name: member ? p.name : undefined,
      components: p.components?.map((c) => parameterShape(c, true)),
    };
  }
  function entryShape(e: Entry) {
    return JSON.stringify({
      type: e.type,
      name: e.name,
      stateMutability: e.stateMutability,
      anonymous: e.anonymous,
      inputs: e.inputs?.map((p) => parameterShape(p)),
      outputs: e.outputs?.map((p) => parameterShape(p)),
    });
  }
  // Solidity may rename top-level arguments when overriding an interface.
  // Retain tuple member names/order/types and every ABI encoding distinction.
  for (const entry of intf.abi as Entry[]) {
    if (
      !learning.abi.some(
        (candidate) => entryShape(candidate) === entryShape(entry),
      )
    )
      throw Error(`interface_implementation_mismatch:${entry.name}`);
  }
  const fields = (fn: string) => {
    const entry = learning.abi.find(
      (e) => e.type === "function" && e.name === fn,
    );
    const tuple = entry?.inputs?.[0];
    if (tuple?.type !== "tuple" || !tuple.components)
      throw Error(`missing_consent_tuple:${fn}`);
    return tuple.components.map(({ name, type }) => ({ name, type }));
  };
  emit("packages/protocol/generated/publication-consent-v1.ts", {
    publicationConsentAbi: intf.abi,
    publicationConsentTypes: {
      PublicationGrant: fields("grant"),
      PublicationWithdrawal: fields("withdraw"),
      PublicationCorrection: fields("correctionDigest"),
    },
  });
  emit("packages/protocol/generated/learning-results-v5.ts", {
    learningResultsV5Abi: learning.abi,
    learningResultsV5Build: learning.profile,
    learningResultsV5RuntimeTemplate: learning.runtime,
  });
  emit("packages/dance-chain/v2/abi.ts", {
    danceVerdictsAbi: dance.abi,
    danceVerdictsBuild: dance.profile,
    danceVerdictsRuntimeTemplate: dance.runtime,
    danceCapturePolicyAbi: capture.abi,
    danceCapturePolicyBuild: capture.profile,
    danceCapturePolicyRuntime: capture.runtime,
  });
  const wire = JSON.parse(
    readFileSync("out/DanceVerdictWireV2.sol/DanceVerdictWireV2.json", "utf8"),
  );
  verifyMetadata(
    wire,
    "contracts/dance/DanceVerdictWireV2.sol",
    "DanceVerdictWireV2",
  );
  const nodes: Ast[] = wire.ast?.nodes?.find(
    (n: Ast) => n.name === "DanceVerdictWireV2",
  )?.nodes;
  if (!nodes) throw Error("missing_compiled_wire_ast");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  function tuple(n: Ast, name: string): Parameter {
    if (n.nodeType !== "StructDefinition" || !n.members)
      throw Error("invalid_wire_struct");
    return {
      name,
      type: "tuple",
      components: n.members.map((m) => {
        const t = m.typeName;
        if (!t || !m.name) throw Error("invalid_wire_member");
        if (t.nodeType === "ElementaryTypeName" && t.name)
          return { name: m.name, type: t.name };
        const child = byId.get(t.referencedDeclaration ?? -1);
        if (!child) throw Error("unresolved_wire_type");
        return tuple(child, m.name);
      }),
    };
  }
  const struct = (name: string, member: string) => {
    const n = nodes.find(
      (n) => n.nodeType === "StructDefinition" && n.name === name,
    );
    if (!n) throw Error(`missing_wire_struct:${name}`);
    return tuple(n, member);
  };
  const ops = nodes.find(
    (n) => n.nodeType === "EnumDefinition" && n.name === "Operation",
  );
  if (!ops?.members) throw Error("missing_wire_operations");
  const operations: Record<string, number> = {};
  const payloads: Record<string, Parameter> = {};
  for (const [i, member] of ops.members.entries()) {
    if (i === 0) continue;
    const name = member.name!;
    const fn = name[0].toLowerCase() + name.slice(1);
    operations[fn] = i;
    payloads[fn] = struct(name, "payload");
  }
  const shapes = Object.fromEntries(
    ["Capture", "Consent", "Submission", "Decision", "Policy", "SourcePin"].map(
      (n) => [
        n[0].toLowerCase() + n.slice(1),
        struct(n, n[0].toLowerCase() + n.slice(1)),
      ],
    ),
  );
  emit("packages/dance-chain/v2/wire-shapes.ts", {
    danceOperation: operations,
    dancePayloads: payloads,
    danceShapes: shapes,
  });
  console.log(
    JSON.stringify({
      learning: learning.profile,
      dance: dance.profile,
      capture: capture.profile,
    }),
  );
}
/** Verify real Forge trace evidence from the admitted constructor/getter tests. */
export function verifyInstantiatedRuntimes(path: string) {
  const input = readFileSync(path, "utf8");
  const suites = JSON.parse(input);
  const signature = keccak256(
    stringToHex("RuntimeEvidence(string,bytes,bytes)"),
  );
  const records = [];
  const names = new Set<string>();
  for (const [suite, result] of Object.entries(suites) as [
    string,
    {
      test_results: Record<
        string,
        {
          status: string;
          logs: { topics: string[]; data: Hex }[];
          traces: [
            string,
            {
              arena: {
                trace: {
                  kind: string;
                  success: boolean;
                  data: string;
                  output: string;
                };
              }[];
            },
          ][];
        }
      >;
    },
  ][]) {
    for (const [test, outcome] of Object.entries(result.test_results)) {
      if (outcome.status !== "Success")
        throw Error(`runtime_proof_failed:${suite}:${test}`);
      for (const event of outcome.logs) {
        if (event.topics.length !== 1 || event.topics[0] !== signature)
          continue;
        const [name, runtime, args] = decodeAbiParameters(
          parseAbiParameters("string,bytes,bytes"),
          event.data,
        );
        if (
          ![
            "LearningResultsV5",
            "DanceVerdictsV2",
            "DanceCapturePolicyV2",
          ].includes(name)
        )
          throw Error("unexpected_runtime_evidence");
        const ir = name !== "LearningResultsV5";
        const selected = load(
          name,
          `contracts/${ir ? "dance/" : ""}${name}.sol`,
          ir,
          ir ? 1 : 200,
        );
        const actual = Buffer.from(runtime.slice(2), "hex"),
          template = Buffer.from(selected.runtime.slice(2), "hex");
        if (actual.length !== template.length)
          throw Error(`runtime_length:${name}`);
        const mask = new Set<number>();
        for (const refs of Object.values(
          selected.profile.immutableReferences,
        ) as { start: number; length: number }[][]) {
          let prior: string | undefined;
          for (const ref of refs) {
            if (
              !Number.isInteger(ref.start) ||
              ref.start < 0 ||
              ref.length !== 32 ||
              ref.start + ref.length > actual.length
            )
              throw Error("invalid_compiler_immutable_range");
            const value = actual
              .subarray(ref.start, ref.start + ref.length)
              .toString("hex");
            if (prior !== undefined && prior !== value)
              throw Error("inconsistent_immutable_substitution");
            prior = value;
            for (let i = ref.start; i < ref.start + ref.length; i++) {
              if (mask.has(i) || template[i] !== 0)
                throw Error("invalid_immutable_template");
              mask.add(i);
            }
          }
        }
        for (let i = 0; i < actual.length; i++)
          if (!mask.has(i) && actual[i] !== template[i])
            throw Error(`runtime_template_mismatch:${name}:${i}`);
        const init = selected.artifact.bytecode.object + args.slice(2);
        const creation = outcome.traces
          .flatMap(([, group]) => group.arena.map((n) => n.trace))
          .find(
            (t) =>
              t.kind === "CREATE" &&
              t.success &&
              t.data === init &&
              t.output === runtime,
          );
        if (!creation) throw Error(`missing_exact_constructor_trace:${name}`);
        names.add(name);
        records.push({
          suite,
          test,
          contract: name,
          compiler: selected.profile.compiler,
          optimizerRuns: selected.profile.optimizerRuns,
          viaIR: selected.profile.viaIR,
          runtimeBytes: actual.length,
          runtimeCodeHash: keccak256(runtime),
          templateHash: selected.profile.runtimeTemplateHash,
          immutableBytes: mask.size,
          constructorArgs: args,
          outsideImmutableRangesMatch: true,
          exactCreationTrace: true,
        });
      }
    }
  }
  if (names.size !== 3) throw Error("incomplete_runtime_evidence");
  const proof = {
    schema: "pirate.publication-runtime-proof/1",
    inputSha256: createHash("sha256").update(input).digest("hex"),
    records,
  };
  console.log(JSON.stringify(proof, null, 2));
  return proof;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length === 0) generatePublicationConsent();
  else if (args.length === 2 && args[0] === "--runtime-proof")
    verifyInstantiatedRuntimes(args[1]);
  else
    throw Error(
      "usage: generate-publication-consent.ts [--runtime-proof FORGE_JSON]",
    );
}
