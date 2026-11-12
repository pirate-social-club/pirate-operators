import assert from "node:assert/strict";
import { digest } from "../packages/protocol/index.ts";
import {
  beginAuthorityAction,
  readAuthorityState,
  type AuthorityAction,
} from "../packages/community-setup/authority-ledger.ts";
import { authorityDenialTransition } from "../packages/community-setup/authority-denials.ts";
import {
  recoverCommunityAuthority,
  progressAuthorityAction,
  type AuthorityRecoveryPorts,
} from "../packages/community-setup/authority-recovery.ts";
import { closeWithdrawnStudyLessons } from "../services/learning-public-results.ts";
import { liveAccountAuthorization } from "../services/learning-sign-in.ts";
import {
  denyManagedStudyPublication,
  type StudyOperatorPorts,
} from "../services/study-operator-client.ts";
import { connectedFactoryFixture } from "./telegram-connected-factory-fixture.ts";

// Exact combined 7ea core required. The provider/RPC boundaries are those of
// the existing V4 fixture; authority, closure, SQL, signing and private Study
// services remain actual production modules. All execution is deferred.
export async function factoryAuthorityFixture(port: number) {
  const f = await connectedFactoryFixture(port);
  try {
    assert.equal((await f.choose()).status, 200);
    await f.factory.alarm();
    const lesson = await f.shared.db
      .prepare("SELECT lesson_id FROM study_lessons WHERE account_id=?")
      .bind(f.session.account_id)
      .first<{ lesson_id: string }>();
    assert.ok(lesson);
    const target = {
      chainId: 31337,
      version: 4,
      contract: f.shared.config.learningRecords,
    } as const;
    const scope = {
      communityId: f.actor.communityId,
      botId: f.actor.botId,
      generation: f.actor.generation,
    };
    const state = await readAuthorityState(f.shared.db, f.session.account_id);
    const action: AuthorityAction = {
      target,
      scope,
      accountId: f.session.account_id,
      wallet: f.session.wallet,
      expectedRevision: state.revision,
      expectedGrantId: f.grant.id,
      actionId: "fixture_factory_off_0001",
      kind: "off",
      atMs: f.shared.clock(),
      cutoffS: Math.floor(f.shared.clock() / 1000),
      revocationNonce: "1",
      originalRevocationId: digest("fixture_factory_off"),
    };
    const operator: StudyOperatorPorts = {
      binding: f.options.study.env.KARAOKE_OPERATOR!,
      issuerKey: f.options.study.env
        .KARAOKE_SIGNER_PRIVATE_KEY as `0x${string}`,
      authority: {
        communityId: f.shared.config.communityId,
        chainId: 31337,
        operator:
          f.shared.env.KARAOKE_OPERATOR_ADDRESS!.toLowerCase() as `0x${string}`,
        contract: target.contract,
      },
      now: f.shared.clock,
    };
    const ports = (): AuthorityRecoveryPorts => {
      const result: AuthorityRecoveryPorts = {
        target,
        usingTarget(named) {
          assert.deepEqual(named, target);
          return result;
        },
        transitions: f.factory.transitions,
        authorizationsOnly: authorityDenialTransition({
          db: f.shared.db,
          target,
          wake: () => f.factory.transitions.arm(),
          deny: async (denial, beforeSend) => {
            const receipt = await denyManagedStudyPublication(
              operator,
              denial,
              beforeSend,
            );
            return { ...receipt, recorded: true as const };
          },
        }),
        wake: () => f.factory.transitions.arm(),
        closeLocal: (id) =>
          closeWithdrawnStudyLessons(f.shared.db, id, f.shared.clock()),
        async observeTurnOn(input) {
          const live = await liveAccountAuthorization(
            f.shared.env,
            input.wallet,
          );
          assert.ok(live);
          return live;
        },
        legacyAction: async (id) => (id === action.accountId ? action : null),
      };
      return result;
    };
    const operation = await beginAuthorityAction(f.shared.db, action, ports());
    const read = () =>
      f.shared.db
        .prepare(
          "SELECT * FROM learning_authority_operations WHERE operation_id=?",
        )
        .bind(operation.operation_id)
        .first<{
          operation_id: string;
          transition_id: string | null;
          complete: number;
          sealed: number;
          request_json: string;
          epoch: number;
        }>();
    return {
      f,
      action,
      operation,
      read,
      ports,
      lessonId: lesson.lesson_id,
      progress: () =>
        progressAuthorityAction(f.shared.db, operation.operation_id, ports()),
      recover: () => recoverCommunityAuthority(f.shared.db, ports()),
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
