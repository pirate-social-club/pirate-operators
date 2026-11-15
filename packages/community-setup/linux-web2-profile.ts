import type { Hex } from "viem";
import { canonical, exact, insist, object, text } from "../community/common.ts";
import { httpsOrigin, ipfsUri } from "../community/manifest-core.ts";
import { sharedBytes32 } from "../community/shared-identity.ts";
import { parseWeb2ProfileDocument, web2ProfileDocument } from "../community/web2-directory.ts";
import { validateWeb2Configuration, type Web2CommunityConfig } from "../community/web2-config-manifest.ts";
import {
  isWeb2Deployment, validateCommunityDeploymentProfile,
  type Web2CommunityDeploymentProfile,
} from "../../services/community-deployment-profile.ts";

/** Public PR60 status. No private invite, signature or signed raw transaction. */
export interface HostedEnrollmentStatus {
  schema: "pirate.hosted-enrollment-status/1";
  enrollmentId: Hex;
  communityId: Hex;
  installationId: Hex;
  profile: ReturnType<typeof web2ProfileDocument>;
  configurationUri: string;
  operations: Array<{
    kind: "registration" | "topup";
    state: "planned" | "signed" | "dispatched" | "consumed" | "reverted";
    transactionHash: Hex | null;
    receipt: unknown;
  }>;
}

export interface LinuxWeb2Draft {
  schema: "pirate.linux-web2-draft/1";
  name: string;
  origin: string;
  deployment: Web2CommunityDeploymentProfile;
  enrollment: HostedEnrollmentStatus;
  configuration: Web2CommunityConfig;
}
export interface LinuxWeb2PlanSelection { planId: string; planDigest: string }
export interface LinuxWeb2PlanSummary extends LinuxWeb2PlanSelection {
  installationId: string;
  summary: {
    communityId: Hex;
    origin: string;
    name: string;
    controller: string;
    publisher: string;
    registrationTransaction: Hex;
    verifiedListing: false;
    namesEnabled: false;
    learningEnabled: false;
    danceEnabled: false;
  };
}
export interface LinuxWeb2Observation extends LinuxWeb2PlanSelection {
  installationId: string;
  state: "prepared" | "starting" | "running" | "unavailable";
  /** An unavailable observation is not a license to recreate resources. */
  reason?: string;
}
export interface LinuxWeb2Installation {
  prepare(value: unknown): Promise<LinuxWeb2PlanSummary>;
  apply(selection: LinuxWeb2PlanSelection): Promise<LinuxWeb2Observation>;
  status(selection: LinuxWeb2PlanSelection): Promise<LinuxWeb2Observation>;
  close(): Promise<void>;
}

export function hostedEnrollmentStatusFrom(value: unknown): HostedEnrollmentStatus {
  const row = object(value);
  exact(row, ["schema", "enrollmentId", "communityId", "installationId", "profile", "configurationUri", "operations"]);
  insist(row.schema === "pirate.hosted-enrollment-status/1", "hosted_status_schema");
  const profile = web2ProfileDocument(parseWeb2ProfileDocument(row.profile));
  insist(row.communityId === profile.communityId && row.installationId === profile.installationId,
    "hosted_status_identity_changed");
  insist(Array.isArray(row.operations) && row.operations.length <= 3, "hosted_status_operations");
  const operations = row.operations.map((value): HostedEnrollmentStatus["operations"][number] => {
    const op = object(value);
    exact(op, ["kind", "state", "transactionHash", "receipt"]);
    insist(op.kind === "registration" || op.kind === "topup", "hosted_status_operation_kind");
    insist(op.state === "planned" || op.state === "signed" || op.state === "dispatched" ||
      op.state === "consumed" || op.state === "reverted", "hosted_status_operation_state");
    return { kind: op.kind, state: op.state,
      transactionHash: op.transactionHash === null ? null : sharedBytes32(op.transactionHash),
      receipt: structuredClone(op.receipt) };
  });
  // A valid status before dispatch may have no operation yet. Installation,
  // below, has the stronger consumed-original requirement.
  insist(operations.filter(op => op.kind === "registration").length <= 1, "ambiguous_registration");
  return { schema: row.schema, enrollmentId: sharedBytes32(row.enrollmentId),
    communityId: profile.communityId, installationId: profile.installationId,
    profile, configurationUri: ipfsUri(row.configurationUri), operations };
}

/** Closed owned values, before any await. This decoder grants no authority. */
export function linuxWeb2DraftFrom(value: unknown): LinuxWeb2Draft {
  const row = object(structuredClone(value));
  exact(row, ["schema", "name", "origin", "deployment", "enrollment", "configuration"]);
  insist(row.schema === "pirate.linux-web2-draft/1", "explicit_web2_installation_required");
  const deployment = validateCommunityDeploymentProfile(row.deployment);
  insist(isWeb2Deployment(deployment), "web2_deployment_required");
  const enrollment = hostedEnrollmentStatusFrom(row.enrollment);
  insist(canonical(enrollment.profile) === canonical(deployment.directoryProfile), "enrollment_deployment_changed");
  const configuration = validateWeb2Configuration(row.configuration, parseWeb2ProfileDocument(enrollment.profile));
  const origin = httpsOrigin(row.origin), name = text(row.name, 63);
  insist(name === configuration.app.label && name === deployment.name && origin === configuration.app.origin &&
    origin === deployment.origin && configuration.postsContract === deployment.posts.address,
    "web2_configuration_selection_changed");
  insist(configuration.learningRecords === "0x0000000000000000000000000000000000000000",
    "first_song_learning_disabled");
  const original = enrollment.operations.find(op => op.kind === "registration");
  insist(original && original.state === "consumed" && original.transactionHash && original.receipt !== null,
    "registration_not_confirmed");
  return { schema: row.schema, name, origin, deployment, enrollment, configuration };
}
