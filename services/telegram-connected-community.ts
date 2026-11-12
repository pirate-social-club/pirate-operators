import type { Hex } from "viem";
import { readAuthorityState } from "../packages/community-setup/authority-ledger.ts";
import { validateManagedAuthorityDelivery } from "../packages/community-setup/authority-validation.ts";
import {
  telegramCheck,
  validateScope,
} from "../packages/telegram/contracts.ts";
import { httpsOrigin } from "../packages/telegram/security.ts";
import type { TelegramLinkedStudyPort } from "../packages/telegram/study-contracts.ts";
import { connectedPracticeAuthorization } from "./learning-sign-in.ts";
import { studyVersion, type StudyCommunityPorts } from "./study-community.ts";
import type { StudyOperatorPorts } from "./study-operator-client.ts";
import { address, chain } from "../packages/community/manifest-core.ts";
import {
  telegramAlarmScheduler,
  type TelegramAlarmStorage,
} from "./telegram-alarm.ts";
import {
  telegramAccountPort,
  telegramWebAccountPorts,
} from "./telegram-accounts.ts";
import { telegramCommunity } from "./telegram-community.ts";
import { frozenTelegramStudy } from "./telegram-frozen-study.ts";
import { telegramLinkedStudy } from "./telegram-linked-study.ts";
import { telegramPublicationAuthority } from "./telegram-publication-authority.ts";

export type TelegramConnectedStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
> &
  TelegramAlarmStorage;

type NativeOptions = Omit<
  Parameters<typeof telegramCommunity>[0],
  | "storage"
  | "accounts"
  | "web"
  | "publication"
  | "authorityValidation"
  | "createLinkedStudy"
  | "scheduleWork"
  | "origin"
  | "now"
>;

export interface TelegramConnectedCommunityOptions extends NativeOptions {
  storage: TelegramConnectedStorage;
  db: D1Database;
  /** Explicit selected community origin. This constructor selects no domain. */
  origin: string;
  study: Omit<StudyCommunityPorts, "db" | "now">;
  assertAccountEnabled(accountId: string): Promise<void>;
  personal: TelegramLinkedStudyPort["personal"];
  now?: () => number;
}

/** Mountable source composition. Requires the held shared authority ledger and
 * the exact protected-adapter proposals in this handback before integration.
 * The returned handlers establish no deployment or connected capability. */
export function telegramConnectedCommunity(
  options: TelegramConnectedCommunityOptions,
) {
  const {
    db,
    storage,
    origin: selectedOrigin,
    study: suppliedStudy,
    assertAccountEnabled,
    personal,
    now = Date.now,
    ...native
  } = options;
  const origin = httpsOrigin(selectedOrigin);
  const config = structuredClone(suppliedStudy.config);
  const env = { ...suppliedStudy.env };
  const registration = {
    ...validateScope(native.registration),
    enabled: native.registration.enabled,
  };
  telegramCheck(
    typeof registration.enabled === "boolean",
    "telegram_bot_invalid",
  );
  telegramCheck(
    origin === selectedOrigin && config.app.origin === origin,
    "telegram_community_origin_changed",
    503,
  );
  telegramCheck(
    registration.communityId === config.communityId &&
      studyVersion(env, config) === 4,
    "telegram_study_target_changed",
    503,
  );

  const publication: StudyOperatorPorts = {
    binding: env.KARAOKE_OPERATOR!,
    issuerKey: env.KARAOKE_SIGNER_PRIVATE_KEY as Hex,
    now,
    authority: {
      chainId: chain(Number(env.KARAOKE_PAYMENT_CHAIN_ID)),
      communityId: config.communityId,
      operator: address(env.KARAOKE_OPERATOR_ADDRESS?.toLowerCase()),
      contract: address(config.learningRecords),
    },
  };
  // The existing local resolver executes the real shared authority service.
  // The remote operator still needs its existing authority binding mounted to
  // this handler by the coordinator; no resource is provisioned here.
  let authority: ReturnType<typeof telegramPublicationAuthority> | undefined;
  const resolver = {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      telegramCheck(authority, "telegram_publication_pending", 503);
      return authority(new Request(input, init));
    },
  } as Fetcher;
  const study = {
    ...suppliedStudy,
    config,
    env: { ...env, STUDY_TELEGRAM_AUTHORITY: resolver },
    now,
  };
  const accounts = telegramAccountPort({
    db,
    assertAccountEnabled,
    authorityState: (accountId) => readAuthorityState(db, accountId),
  });
  const community = telegramCommunity({
    ...native,
    registration,
    storage,
    origin,
    now,
    accounts,
    publication,
    // Derived from this factory's D1. The combined 7ea constructor forwards
    // it to the guarded lifecycle used by ready/recover/alarm alike.
    authorityValidation: (request) =>
      validateManagedAuthorityDelivery(db, request),
    web: telegramWebAccountPorts({
      db,
      scope: registration,
      origin,
      accounts,
      now,
    }),
    scheduleWork: telegramAlarmScheduler(storage),
    createLinkedStudy(grants, lifecycle) {
      lifecycle.assertAuthority(publication.authority);
      return telegramLinkedStudy({
        grants,
        publication: lifecycle,
        db,
        authorize: (context, resolveLink) =>
          connectedPracticeAuthorization(
            study.env,
            db,
            context,
            resolveLink,
            now(),
          ),
        createStudy: (session, channel, context, privateDb) =>
          frozenTelegramStudy(
            study,
            session,
            channel,
            context,
            privateDb,
            lifecycle,
          ),
        personal,
      });
    },
  });
  authority = telegramPublicationAuthority({
    db,
    env: study.env,
    grants: community.transitions.grants,
    communityId: config.communityId,
    contract: publication.authority.contract,
    publication: community.transitions,
  });
  return {
    ...community,
    publicationAuthority: authority,
    alarm: () => community.tick(),
  };
}
