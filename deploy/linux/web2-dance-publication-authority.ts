import assert from "node:assert/strict";
import type { Hex } from "viem";
import { canonical } from "../../packages/community/common.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { web2DanceAuthorityMode } from "./web2-dance-retained-files.ts";
import { readApprovedExpandedPublication } from "./web2-expanded-publication.ts";
import type { Web2ChainAuthority } from "./web2-profile-authority.ts";
import { readTrustedNativePublication } from "./web2-trusted-publication.ts";
import { readApprovedTrustedRevisionTwo } from "./web2-trusted-revision-two.ts";

type FixtureApproval = Awaited<ReturnType<typeof readApprovedExpandedPublication>>;
export type Web2DancePublicationApproval = Pick<FixtureApproval,
  "approvalSha256" | "selectionSha256" | "selection" | "configuration" | "ownerWallet"> & { publicGenesisHash?: Hex };

type TrustedApproval = Awaited<ReturnType<typeof readApprovedTrustedRevisionTwo>>;
type TrustedAttachment = NonNullable<Awaited<ReturnType<typeof readTrustedNativePublication>>>;

/** Projection of two verified originals. The public approval has no fixture
 * selection. Its separately signed companion supplies the selector and catalog. */
export function projectTrustedWeb2DanceAuthority(approval: TrustedApproval, attachment: TrustedAttachment) {
  const { body, initialization } = attachment, { selection, selector } = initialization;
  assert(body.approvalSha256 === approval.approvalSha256 &&
    body.graphSha256 === approval.approval.graphSha256 &&
    selection.installationId === approval.configuration.installationId && selection.active && selection.previous === null,
    "web2_public_dance_approval_changed");
  return {
    mode: "trusted-public" as const,
    approval: {
      approvalSha256: approval.approvalSha256,
      selectionSha256: selector.body.mount.selectionSha256,
      selection: { ...selection, installationId: approval.configuration.installationId, active: selection.active, previous: null },
      configuration: approval.configuration,
      ownerWallet: approval.approval.ownerWallet,
      publicGenesisHash: approval.approval.genesisHash,
    } satisfies Web2DancePublicationApproval,
    publicationMount: canonical(selector),
    companion: attachment.raw,
  };
}

/** The fixture and public readers remain independently authorized. There is
 * no fallback to fixture transport or a D1-selected release on public ACME. */
export async function readWeb2DancePublicationAuthority(input: {
  graph: NativeGraph; original: Web2NativeOriginal; chain: Web2ChainAuthority; now: () => number;
}) {
  if (web2DanceAuthorityMode(input.graph) === "fixture")
    return { mode: "fixture" as const, approval: await readApprovedExpandedPublication(input) };
  const approval = await readApprovedTrustedRevisionTwo(input);
  const attachment = await readTrustedNativePublication({ ...input, approval });
  assert(attachment, "trusted_web2_publication_attachment_required");
  const again = await readApprovedTrustedRevisionTwo(input);
  assert(again.approvalSha256 === approval.approvalSha256, "web2_public_dance_approval_changed");
  return projectTrustedWeb2DanceAuthority(again, attachment);
}

export function sameWeb2DancePublicationAuthority(
  a: Awaited<ReturnType<typeof readWeb2DancePublicationAuthority>>,
  b: Awaited<ReturnType<typeof readWeb2DancePublicationAuthority>>,
) {
  return a.mode === b.mode && a.approval.approvalSha256 === b.approval.approvalSha256 &&
    a.approval.selectionSha256 === b.approval.selectionSha256 &&
    (a.mode === "fixture" || b.mode === "trusted-public" && a.companion === b.companion);
}
