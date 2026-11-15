// Explicit new protocol. V1 bytes are never silently promoted.
import {httpsOrigin} from "../community/manifest-core.ts";
import {storageProfileFrom} from "./storage.ts";
import type {LinuxDraftV1, LinuxTarget, SessionPolicy} from "./linux-draft.ts";
import {fields, record, requireLinux, text, natural, reference} from "./linux-input.ts";
export type {LinuxTarget, SessionPolicy};
export interface LinuxDraftV2 extends Omit<LinuxDraftV1, "version"> {
  version: 2;
  infrastructure: "pirate.shared-directory/2";
}
export const publicOrigin = (value: unknown) => httpsOrigin(value);
export function targetFrom(value: unknown): LinuxTarget {
  const o = record(value);
  if (o.kind === "local-linux") {
    fields(o, ["kind"]);
    return { kind: "local-linux" };
  }
  fields(o, ["kind", "host", "port", "user", "connectionRef"]);
  const host = text(o.host, 253),
    user = text(o.user, 64);
  requireLinux(
    o.kind === "ssh-linux" &&
      /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host) &&
      /^[a-z_][a-z0-9_-]*$/.test(user),
    "invalid_ssh_target",
    "Select a user-owned Linux host, SSH account and managed connection.",
  );
  const port = natural(o.port, 65535);
  requireLinux(
    port > 0,
    "invalid_ssh_port",
    "Use an SSH port between 1 and 65535.",
  );
  return {
    kind: "ssh-linux",
    host,
    port,
    user,
    connectionRef: reference(o.connectionRef),
  };
}
export function linuxDraftFrom(value: unknown): LinuxDraftV2 {
  const o = fields(value, [
    "version", "infrastructure",
    "mode",
    "name",
    "slug",
    "origin",
    "target",
    "namespace",
    "features",
    "services",
    "storage",
    "limits",
    "recovery",
  ]);
  requireLinux(
    o.version === 2 && o.infrastructure === "pirate.shared-directory/2" && ["create", "import", "restore"].includes(String(o.mode)),
    "profile_version",
    "Select the explicit shared Directory/profile v2; legacy adoption needs a reviewed cutover.",
  );
  const slug = text(o.slug, 30);
  requireLinux(
    /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug),
    "invalid_slug",
    "Use 3–30 lowercase letters, numbers and hyphens for the community identifier.",
  );
  const ns = fields(o.namespace, ["tld"]),
    tld = text(ns.tld, 63);
  requireLinux(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tld),
    "namespace_required",
    "Enter the controlled TLD to import, without dots. Hosting does not prove its authority.",
  );
  const f = fields(o.features, [
    "learning",
    "karaoke",
    "media",
    "dance",
    "telegram",
  ]);
  requireLinux(
    Object.values(f).every((v) => typeof v === "boolean") &&
      (!f.karaoke || f.learning) &&
      (!f.dance || f.media) &&
      (!f.telegram || f.learning),
    "feature_dependencies",
    "Karaoke and connected Telegram require Learning; Dance requires private media.",
  );
  const services = fields(o.services, [
    "publicationProfile",
    "learningProfile",
  ]);
  requireLinux(
    f.learning
      ? typeof services.learningProfile === "string"
      : services.learningProfile === null,
    "learning_profile_required",
    "Select an available Learning profile, or turn Learning off.",
  );
  const s = fields(o.storage, ["publicMedia", "privateData", "backup"]),
    privateData = fields(s.privateData, ["provider"]);
  const publicMedia = storageProfileFrom(s.publicMedia),
    backup = storageProfileFrom(s.backup);
  requireLinux(
    publicMedia.role === "public-ipfs" &&
      backup.role === "backup" &&
      privateData.provider === "local-volume",
    "storage_roles",
    "Keep public IPFS media, private persistent data and encrypted backup transport separate.",
  );
  const l = fields(o.limits, [
    "speechDaily",
    "websiteReserved",
    "perAccountDaily",
    "monthlyUsdCents",
  ]);
  const limits = {
    speechDaily: natural(l.speechDaily, 1000000),
    websiteReserved: natural(l.websiteReserved, 1000000),
    perAccountDaily: natural(l.perAccountDaily, 1000000),
    monthlyUsdCents: natural(l.monthlyUsdCents, 100000000),
  };
  requireLinux(
    limits.websiteReserved <= limits.speechDaily &&
      limits.perAccountDaily <= limits.speechDaily &&
      (!f.learning || limits.speechDaily > 0),
    "speech_limits",
    "Reserve website capacity within the community daily limit; Learning needs a positive allowance.",
  );
  const recovery = fields(o.recovery, ["sessionPolicy"]);
  requireLinux(
    ["revoke-existing", "preserve-existing"].includes(
      String(recovery.sessionPolicy),
    ),
    "session_policy_required",
    "Choose whether restored sessions are revoked or preserved.",
  );
  return {
    version: 2,
    infrastructure: "pirate.shared-directory/2",
    mode: o.mode as LinuxDraftV2["mode"],
    name: text(o.name, 80),
    slug,
    origin: publicOrigin(o.origin),
    target: targetFrom(o.target),
    namespace: { tld },
    features: f as LinuxDraftV2["features"],
    services: {
      publicationProfile: reference(services.publicationProfile),
      learningProfile: f.learning ? reference(services.learningProfile) : null,
    },
    storage: { publicMedia, privateData: { provider: "local-volume" }, backup },
    limits,
    recovery: { sessionPolicy: recovery.sessionPolicy as SessionPolicy },
  };
}
