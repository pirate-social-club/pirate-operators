import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./study-operator-fixture.ts";
import { operatorProfile } from "../harness/study-operator-profile.ts";
import { observeOperatorCloud } from "../harness/study-operator-readonly-adapter.ts";
import { hashJson } from "../packages/community/common.ts";
import { fileDigest } from "../harness/creator-state.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";

async function observe(options: {
  declared?: 2 | 3;
  liveVersion: 2 | 3 | 4;
  v4Selection?: boolean;
  wrongV4?: boolean;
  activationReplacement?: boolean;
  wrongActivation?: boolean;
  successor?: boolean;
  missingV3?: boolean;
  wrongV3?: boolean;
  unknownModule?: boolean;
}) {
  const p = fixture();
  if (options.declared !== undefined)
    p.predecessor.resultsVersion = options.declared;
  if (options.v4Selection)
    p.learningV4 = {
      schema: "pirate.learning-v4-release-selection/1",
      chainId: 6343,
      contract: "0x4444444444444444444444444444444444444444",
      codeHash: `0x${"4".repeat(64)}`,
      controller: p.selection.controller,
      publicationPolicy: learningV4PublicityPolicy,
      policyVersion: 4,
      communityOrigin: firstSong.origin,
    };
  if (options.activationReplacement)
    p.activationAccount = {
      previous: "0x3333333333333333333333333333333333333333",
      next: "0x5555555555555555555555555555555555555555",
    };
  const oldModule = "export default {old:true};",
    newModule = "export default {new:true};";
  p.predecessor.moduleSha256 = fileDigest(Buffer.from(oldModule));
  p.execution.predecessorFiles[0]!.sha256 = p.predecessor.moduleSha256;
  p.artifact.sha256 = fileDigest(Buffer.from(newModule));
  const bindings: {
    name: string;
    type: string;
    text?: string;
    namespace_id?: string;
    class_name?: string;
  }[] = [
    ...Object.entries(p.objects).map(([name, value]) => ({
      name,
      type: "durable_object_namespace",
      namespace_id: value.namespaceId,
      class_name: value.className,
    })),
    {
      name: "RESULTS_V2_CONTRACT",
      type: "plain_text",
      text: p.selection.resultsV2.contract,
    },
  ];
  if (p.activationAccount)
    bindings.push({
      name: "APPROVED_ACTIVATION_ACCOUNT",
      type: "plain_text",
      text: p.activationAccount.previous,
    });
  p.predecessor.publicSettingsInvariantSha256 = hashJson({
    bindings: [...bindings].sort((a, b) => a.name.localeCompare(b.name)),
  });
  const settings = {
    bindings: [
      ...bindings.map((b) =>
        b.name === "APPROVED_ACTIVATION_ACCOUNT" && p.activationAccount
          ? {
              ...b,
              text:
                !!options.successor !== !!options.wrongActivation
                  ? p.activationAccount.next
                  : p.activationAccount.previous,
            }
          : b,
      ),
      {
        name: "OPERATOR_PROFILE",
        type: "plain_text",
        text:
          options.liveVersion >= 3
            ? "pirate-learning-testnet-v3"
            : "pirate-karaoke-testnet-v2",
      },
      ...(options.liveVersion >= 3 && !options.missingV3
        ? [
            {
              name: "RESULTS_V3_CONTRACT",
              type: "plain_text",
              text: options.wrongV3
                ? p.selection.resultsV2.contract
                : p.selection.resultsV3.contract,
            },
          ]
        : []),
      ...(options.liveVersion === 4
        ? [
            {
              name: "RESULTS_V4_CONTRACT",
              type: "plain_text",
              text: options.wrongV4
                ? p.selection.resultsV2.contract
                : "0x4444444444444444444444444444444444444444",
            },
          ]
        : []),
    ],
  };
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "manual");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    requests.push(url.pathname);
    if (url.pathname.endsWith("/settings"))
      return Response.json({ success: true, result: settings });
    if (url.pathname.endsWith("/" + p.worker.name))
      return new Response(
        options.unknownModule
          ? "different"
          : options.successor
            ? newModule
            : oldModule,
      );
    assert.ok(url.pathname.endsWith("/workers/scripts"));
    return Response.json({
      success: true,
      result: [{ id: p.worker.name, tag: p.worker.tag }],
    });
  };
  try {
    const observed = await observeOperatorCloud(
      p,
      "local-fixture-token",
      "operator.mjs",
    );
    assert.equal(requests.length, 3);
    assert.equal(
      observed.moduleSha256,
      options.successor ? p.artifact.sha256 : p.predecessor.moduleSha256,
    );
  } finally {
    globalThis.fetch = original;
  }
}

test("historical V2 boundary is retained and a V3 predecessor requires explicit matching bindings", async () => {
  await observe({ liveVersion: 2 });
  await observe({ declared: 2, liveVersion: 2 });
  await observe({ declared: 3, liveVersion: 3 });
  for (const options of [
    { liveVersion: 3 as const },
    { declared: 3 as const, liveVersion: 2 as const },
    { declared: 3 as const, liveVersion: 3 as const, missingV3: true },
    { declared: 3 as const, liveVersion: 3 as const, wrongV3: true },
  ])
    await assert.rejects(
      observe(options),
      /study_operator_(result_bindings|v3_binding|binding)_changed/,
    );
});

test("every exact successor still requires V3 and neither version accepts an unrelated module", async () => {
  await observe({ liveVersion: 3, successor: true });
  await observe({ declared: 3, liveVersion: 3, successor: true });
  await assert.rejects(
    observe({ liveVersion: 2, successor: true }),
    /result_bindings_changed/,
  );
  await assert.rejects(
    observe({ declared: 3, liveVersion: 3, unknownModule: true }),
    /live_module_changed/,
  );
});

test("malformed predecessor versions are refused before any cloud access", () => {
  for (const value of [null, "3", 0, 4, true]) {
    const p = fixture();
    (p.predecessor as Record<string, unknown>).resultsVersion = value;
    assert.throws(() => operatorProfile(p), /predecessor_version_invalid/);
  }
});

test("V4 binding is admitted only on the exact selected successor, retaining V3 before deployment", async () => {
  await observe({ declared: 3, liveVersion: 3, v4Selection: true });
  await observe({
    declared: 3,
    liveVersion: 4,
    v4Selection: true,
    successor: true,
  });
  for (const options of [
    { declared: 3 as const, liveVersion: 4 as const, v4Selection: true },
    {
      declared: 3 as const,
      liveVersion: 3 as const,
      v4Selection: true,
      successor: true,
    },
    { declared: 3 as const, liveVersion: 4 as const, successor: true },
    {
      declared: 3 as const,
      liveVersion: 4 as const,
      v4Selection: true,
      successor: true,
      wrongV4: true,
    },
  ])
    await assert.rejects(
      observe(options),
      /study_operator_(v4_binding|binding)_changed/,
    );
});

test("the selected pilot activation account changes only with the exact V4 module", async () => {
  await observe({
    declared: 3,
    liveVersion: 3,
    v4Selection: true,
    activationReplacement: true,
  });
  await observe({
    declared: 3,
    liveVersion: 4,
    v4Selection: true,
    activationReplacement: true,
    successor: true,
  });
  await assert.rejects(
    observe({
      declared: 3,
      liveVersion: 3,
      v4Selection: true,
      activationReplacement: true,
      wrongActivation: true,
    }),
    /activation_binding_changed/,
  );
  await assert.rejects(
    observe({
      declared: 3,
      liveVersion: 4,
      v4Selection: true,
      activationReplacement: true,
      successor: true,
      wrongActivation: true,
    }),
    /activation_binding_changed/,
  );
});
