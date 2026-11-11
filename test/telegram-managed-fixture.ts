import assert from "node:assert/strict";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { digest } from "../packages/protocol/index.ts";
import { verifyStudyAuthorization } from "../packages/study/operator-auth.ts";
import {
  telegramStudyDenial,
  type TelegramStudyDenial,
} from "../packages/study/telegram-publication.ts";
import type { BotRegistration } from "../packages/telegram/contracts.ts";
import { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import type { TelegramGrants } from "../services/telegram-grants.ts";
import type { StudyOperatorPorts } from "../services/study-operator-client.ts";
import { actor } from "./telegram-fixture.ts";

/** Public fixture signer; only the supplied mocked Fetcher is used. The mock
 * verifies the actual signed request and stores an idempotent exact receipt. */
export function managedFixture(
  grants: TelegramGrants,
  registration: BotRegistration = { ...actor, enabled: true },
  target: Partial<StudyOperatorPorts["authority"]> = {},
) {
  const issuerKey = ("0x" + "12".repeat(32)) as Hex;
  const issuer = privateKeyToAccount(issuerKey).address;
  const authority: StudyOperatorPorts["authority"] = {
    communityId: actor.communityId as Hex,
    chainId: 6343,
    operator: ("0x" + "a1".repeat(20)) as Hex,
    contract: ("0x" + "b2".repeat(20)) as Hex,
    ...target,
  };
  const denials = new Map<string, TelegramStudyDenial>(),
    unavailableGrants = new Set<string>(),
    requests: string[] = [],
    alarms: number[] = [];
  let offline = false,
    lose = false,
    wrong = false,
    scheduleFails = false;
  const ports: StudyOperatorPorts = {
    authority,
    issuerKey,
    now: grants.now,
    binding: {
      async fetch(url: string, init?: RequestInit) {
        if (offline) throw Error("fixture_denial_offline");
        const request = new Request(url, init);
        const signed = await verifyStudyAuthorization(
          request,
          authority,
          issuer,
          Math.floor(grants.now() / 1000),
        );
        assert.equal(signed.path, "/study/telegram/deny");
        assert.equal(
          sha256(new Uint8Array(await request.clone().arrayBuffer())),
          signed.bodyHash,
        );
        const denial = telegramStudyDenial(await request.json()),
          hash = digest(denial);
        if (denial.kind === "grant" && unavailableGrants.has(denial.grantId))
          throw Error("fixture_grant_denial_offline");
        requests.push(hash);
        denials.set(hash, denial);
        if (lose) {
          lose = false;
          throw Error("fixture_lost_denial_ack");
        }
        return Response.json({
          recorded: true,
          denialHash: wrong ? digest("wrong") : hash,
        });
      },
    } as unknown as Fetcher,
  };
  const scheduleWork = async (at: number) => {
    if (scheduleFails) throw Error("fixture_wake_unavailable");
    alarms.push(at);
  };
  const create = (next = registration, owner = grants) =>
    TelegramManagedPublication.create({
      grants: owner,
      registration: next,
      ports,
      scheduleWork,
    });
  return {
    publication: create(),
    create,
    ports,
    denials,
    requests,
    alarms,
    scheduleWork,
    holdGrant: (id: string) => {
      unavailableGrants.add(id);
    },
    offline: (value: boolean) => {
      offline = value;
    },
    lost: () => {
      lose = true;
    },
    wrong: (value: boolean) => {
      wrong = value;
    },
    scheduleFails: (value: boolean) => {
      scheduleFails = value;
    },
  };
}
