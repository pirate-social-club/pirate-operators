import type { PublicClient } from "viem";
import { canonical, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import type { DancePorts } from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { validateAuthority } from "../packages/dance/validation.ts";
import type { CommunityMediaPorts } from "./community-media-ports.ts";
import { CommunityPrivateDance, type PrivateMediaJob } from "./community-private-dance.ts";
import { createProductionDanceAuthority, type DanceAccountAuthorityFacts } from "./dance-production-authority.ts";
import {
  createProductionDancePorts, requireDanceProductionSelection,
  type DanceSelectedCatalogue,
} from "./dance-production.ts";
import { DanceSource3Bindings } from "./dance-source3-bindings.ts";

export interface DanceVerifiedHostInputs {
  accounts(community: string, actor: string, learner: string): Promise<DanceAccountAuthorityFacts>;
  catalogue: DanceSelectedCatalogue;
  /** Exact canonical publication + measured audio, never a fixture/feed readiness flag. */
  song: CommunityMediaPorts["song"];
}
/** In-process Root-owned service composition, NOT a JSON/browser/env permission
 * flag. Host v3 has finite source clearance; actual private authority,
 * catalogue/resource/lease/probe producers and Root runtime admission remain
 * required. Interface alignment is not real producer acceptance. */
export interface DanceProductionRuntimeInputs {
  selectionJson: string;
  selectionHash: string;
  reviewerConsent: DancePorts["reviewerConsent"];
  client: PublicClient;
  renderer: Pick<Fetcher, "fetch">;
  host(input: {
    db: D1Database; source: DanceCanonicalSource; config: CommunityConfig;
    client: PublicClient;
  }): Promise<DanceVerifiedHostInputs>;
  /** Must reconcile current admission/configuration, not return a cached boolean. */
  current(config: CommunityConfig, source: DanceCanonicalSource): Promise<void>;
}

/** The SAME factory is called by default HTTP, queue and scheduled paths.
 * It only composes selected services. It does not send canonical commands,
 * choose providers, populate projections, apply DDL or activate public posts. */
export function createDanceProductionDefaults(input: {
  db: D1Database; bucket: R2Bucket;
  enqueue(job: PrivateMediaJob): Promise<void>;
  selected?: DanceProductionRuntimeInputs;
  now?: () => number;
}) {
  input = { ...input };
  return async (config: CommunityConfig): Promise<CommunityPrivateDance> => {
    const admitted = input.selected;
    insist(admitted && typeof admitted.host === "function" &&
      typeof admitted.current === "function" && admitted.renderer && admitted.client,
      "dance_production_inputs_unavailable", 503);
    const selected = { ...admitted, reviewerConsent: structuredClone(admitted.reviewerConsent) };
    // Capture the config value so mutation during an async producer cannot
    // silently rebind this runtime to another release or community.
    const original = canonical(config), captured = structuredClone(config);
    const source = requireDanceProductionSelection({ ...selected, config: captured });
    const current = async () => {
      await selected.current(structuredClone(captured), structuredClone(source));
      insist(canonical(config) === original && canonical(captured) === original,
        "dance_production_configuration_changed", 503);
    };
    await current();
    const host = await selected.host({ db: input.db, source: structuredClone(source),
      config: structuredClone(captured), client: selected.client });
    insist(host && typeof host.accounts === "function" && host.catalogue && typeof host.song === "function",
      "dance_production_host_unavailable", 503);
    const authority = createProductionDanceAuthority({ ...input, source, config: captured,
      client: selected.client, accounts: host.accounts });
    const dance = createProductionDancePorts({ ...input, source, client: selected.client,
      catalogue: host.catalogue, authority: authority.authority,
      reviewerConsent: structuredClone(selected.reviewerConsent) });
    const source3 = new DanceSource3Bindings({ db: input.db,
      communityId: captured.communityId, sourceHash: source.sourceHash, dance });
    await current();
    insist(canonical(config) === original, "dance_production_configuration_changed", 503);
    return new CommunityPrivateDance({
      db: input.db, bucket: input.bucket, communityId: captured.communityId,
      renderer: selected.renderer, dance: { ...dance, async mediaBindingHash(binding) {
        binding = structuredClone(binding);
        await source3.assertSubmission(binding.mediaId, binding.captureHash, binding.recordingSha256);
        return dance.mediaBindingHash(binding);
      } }, catalogue: host.catalogue, source3, current,
      async active(actor) {
        await current();
        const facts = structuredClone(await dance.authority(captured.communityId, actor.accountId, actor.accountId));
        validateAuthority(facts, actor.accountId, actor.accountId);
        await new DanceStore(input.db).assert([facts.fence]);
        return true;
      },
      async song(key, revision) {
        await current();
        const song = structuredClone(await host.song(key, revision));
        insist(song.communityId === captured.communityId && song.songKey === key &&
          song.songRevision === revision, "dance_source3_song_changed", 409);
        return song;
      },
      reservation: (actor, intent, song) => source3.reservation(actor, intent, song),
      preview: (actor, media) => source3.preview(actor, media),
      enqueue: input.enqueue, now: input.now,
    });
  };
}
