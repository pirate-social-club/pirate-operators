// Memory-only SQL fixture: actual migrations/services, no workerd, socket or
// chain. The D1 adapter models atomic batches and interrupted responses; it
// does not establish D1 transport or process-restart conformance.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { digest } from "../packages/protocol/index.ts";
import { studyExercisesHash } from "../packages/protocol/learning-results-v3.ts";
import { StudyAttemptStore } from "../packages/study/attempt-store.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { newLesson, songOf } from "../packages/study/lesson.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { publicPostsProfile } from "../services/first-song-runtime.ts";
import type {
  CommunityEnv,
  CommunityDependencies,
} from "../services/community-application.ts";
import type { StudyAuthorizationBinding } from "../services/study-operator.ts";
import type { PublicReadPorts } from "../services/community-public.ts";

export interface SqlResponse {
  kind: string;
  sql: string;
}
export class MemoryD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  responses: SqlResponse[] = [];
  afterResponse?: (response: SqlResponse) => void | Promise<void>;
  // Only the operations used by the real services are adapted. Unsupported
  // platform APIs are absent, so an unexpected use fails the fixture.
  readonly db = {
    prepare: (sql: string) => this.prepare(sql),
    batch: async (statements: MemoryStatement[]) => {
      this.sqlite.exec("BEGIN");
      let results;
      try {
        results = statements.map((s) => s.execute());
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
      await this.response("batch", statements.map((s) => s.sql).join(";"));
      return results;
    },
  } as unknown as D1Database;
  prepare(sql: string) {
    return new MemoryStatement(this, sql);
  }
  async response(kind: string, sql: string) {
    const response = { kind, sql };
    this.responses.push(response);
    await this.afterResponse?.(response);
  }
  close() {
    this.sqlite.close();
  }
}
class MemoryStatement {
  readonly owner: MemoryD1;
  readonly sql: string;
  readonly values: SQLInputValue[];
  constructor(owner: MemoryD1, sql: string, values: SQLInputValue[] = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: SQLInputValue[]) {
    return new MemoryStatement(this.owner, this.sql, values);
  }
  execute() {
    const statement = this.owner.sqlite.prepare(this.sql),
      rows = statement.all(...this.values),
      changes = Number(
        this.owner.sqlite.prepare("SELECT changes() n").get()!.n,
      );
    return { success: true, results: rows, meta: { changes } };
  }
  async all() {
    const result = this.execute();
    await this.owner.response("all", this.sql);
    return result;
  }
  async first(column?: string) {
    const row = this.execute().results[0] ?? null;
    await this.owner.response("first", this.sql);
    return column && row ? row[column] : row;
  }
  async run() {
    const result = this.execute();
    await this.owner.response("run", this.sql);
    return result;
  }
}

// Same public disposable fixture keys as harness/runtime.ts, never generated
// or sent anywhere. They sign only an in-memory service-request envelope.
const issuerKey = `0x${"2".padStart(64, "0")}` as const;
export const wallet = privateKeyToAccount(
  `0x${"6".padStart(64, "0")}`,
).address.toLowerCase();
const operator = privateKeyToAccount(`0x${"3".padStart(64, "0")}`).address;
export const authorizationId = digest("withdrawal-memory-authorization");
const communityId = firstSong.directoryProfile.communityId;
const owner = { accountId: "a", communityId };
const now = 1800000000000;
export async function withdrawalFixture(
  publicationState: "bound" | "pending" = "bound",
) {
  const memory = new MemoryD1(),
    db = memory.db;
  try {
    for (const name of [
      "0001_setup.sql",
      "0002_first_song.sql",
      "0003_publication_journal.sql",
      "0004_creator_connection.sql",
      "0005_input_capabilities.sql",
      "0006_song_stems.sql",
      "0007_owner_curated.sql",
      "0008_karaoke.sql",
      "0009_study.sql",
      "0010_study_retention.sql",
      "0013_learning_authorization.sql",
    ])
      memory.sqlite.exec(
        await readFile(
          new URL(
            `../apps/community-wizard/infra/migrations/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    const readConfig = async (name: string) =>
      JSON.parse(
        await readFile(
          new URL(`../docs/deployments/${name}`, import.meta.url),
          "utf8",
        ),
      ).configuration;
    const original = validateConfig(
      await readConfig("first-song-managed-20261105.configuration.json"),
    );
    const config = validateConfig(
      {
        ...(await readConfig(
          "first-song-managed-20261105.curated-configuration.json",
        )),
        learningRecords: operator.toLowerCase(),
      },
      [original],
    );
    await db
      .prepare("INSERT INTO application_identity VALUES(1,?,?)")
      .bind(communityId, firstSong.origin)
      .run();
    await db
      .prepare(
        "INSERT INTO community_accounts VALUES('a','author-a',0),('b','author-b',0)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO credential_bindings VALUES('binding','a','moss',6343,?,0)",
      )
      .bind(wallet)
      .run();
    await db
      .prepare(
        `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
      VALUES(?,'a',?,'{}','','0x',?,4,?,'recorded',0,0)`,
      )
      .bind(authorizationId, wallet, authorizationId, now / 1000 - 2)
      .run();
    const source = createLyrics(
      {
        chainId: 6343,
        postsContract: config.postsContract,
        communityId,
        postId: digest("withdrawal-memory-song"),
      },
      "Sing the first refrain\nHold the second note\nHear the third refrain\nKeep the fourth beat",
      "en",
    );
    const ordinals = [1, 2, 3, 4],
      selected = studySourceSelection(source, ordinals);
    const state = newLesson(
      songOf(selected.selected[0]),
      selected.selected,
      now - 1000,
    );
    const store = new StudyLessonStore(db),
      attempts = new StudyAttemptStore(db);
    const row = await store.create(owner, "lesson-request", state);
    const take = await attempts.open(
      owner,
      "attempt-request",
      selected.selected[0],
      now - 500,
      {
        lessonId: row.lesson_id,
        presentationNumber: 1,
        takeNumber: 1,
      },
    );
    await store.update(owner, row, {
      ...state,
      currentAttemptId: take.attemptId,
    });
    const audioDigest = digest("retained-uncertain-audio");
    await attempts.claim(owner, take.attemptId, audioDigest, now, 2000);
    const target = {
      chainId: 6343,
      version: 4,
      contract: config.learningRecords,
    } as const;
    const offer = {
      lessonId: row.lesson_id,
      learner: wallet as `0x${string}`,
      sourceDigest: selected.hash,
      startedAt: state.startedAt,
      expiresAt: state.expiresAt,
      authorizationId,
      exercises: selected.selected.map((line, i) => ({
        ordinal: ordinals[i],
        lineId: line.lineId as `0x${string}`,
        language: line.language,
      })),
    };
    const binding: StudyAuthorizationBinding = {
      offer,
      offerHash: digest(offer),
      exercisesHash: studyExercisesHash(ordinals),
      target,
      authorization: { id: authorizationId, issuedAt: now / 1000 - 2, target },
    };
    const receipt = JSON.stringify({
      state: "pending",
      transactionHash: digest("uncertain-transaction"),
      providerEvidence: "retained",
    });
    await db
      .prepare(
        `INSERT INTO study_publications(lesson_id,account_id,community_id,learner,source_json,binding_json,state,receipt_json,created_at,updated_at)
      VALUES(?,'a',?,?,?,?,?,?,?,?)`,
      )
      .bind(
        row.lesson_id,
        communityId,
        wallet,
        JSON.stringify(source),
        JSON.stringify(binding),
        publicationState,
        receipt,
        now,
        now,
      )
      .run();
    // A different account must remain untouched by local withdrawal.
    const foreign = await store.create(
      { accountId: "b", communityId },
      "foreign-lesson",
      state,
    );
    const unexpected = async (): Promise<never> => {
      throw Error("unexpected fixture I/O");
    };
    const env: CommunityEnv = {
      DB: db,
      MEDIA: {} as R2Bucket,
      ASSETS: { fetch: unexpected } as unknown as Fetcher,
      JOBS: { send: unexpected } as unknown as CommunityEnv["JOBS"],
      COMMUNITY_NAME: "Memory community",
      PLAN_ID: firstSong.planId,
      APPLICATION_PROFILE_HASH: digest("memory-profile"),
      MANAGED_PROFILE_HASH: digest("memory-managed-profile"),
      COMMUNITY_PUBLISHER_PRIVATE_KEY: issuerKey,
      KARAOKE_SERVICE_MODE: "internal",
      KARAOKE_OPERATOR_ADDRESS: operator,
      KARAOKE_SIGNER_PRIVATE_KEY: issuerKey,
      KARAOKE_PAYMENT_CHAIN_ID: "6343",
      STUDY_RESULTS_V4_CONTRACT: config.learningRecords,
      KARAOKE_OPERATOR: { fetch: unexpected } as unknown as Fetcher,
    };
    const dependencies: CommunityDependencies = {
      configuration: async () => config,
      verifyLogin: unexpected,
      creatorHealth: async () => false,
      now: () => now,
      publicReads: {
        client: new Proxy(
          {},
          { get: () => unexpected },
        ) as PublicReadPorts["client"],
        profile: publicPostsProfile(),
        transport: unexpected,
      },
    };
    const withdraw = () =>
      db
        .prepare(
          "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES('a',?,?)",
        )
        .bind(now, now)
        .run();
    const publication = () =>
      db
        .prepare("SELECT * FROM study_publications WHERE lesson_id=?")
        .bind(row.lesson_id)
        .first<{
          state: string;
          source_json: string;
          binding_json: string;
          receipt_json: string;
          terminal_json: string | null;
        }>();
    const ports = {
      env,
      db,
      config,
      reads: dependencies.publicReads!,
      now: () => now,
    };
    memory.responses = [];
    return {
      memory,
      db,
      env,
      dependencies,
      ports,
      store,
      attempts,
      owner,
      row,
      take,
      foreign,
      now,
      audioDigest,
      state,
      withdraw,
      publication,
      close: () => memory.close(),
    };
  } catch (error) {
    memory.close();
    throw error;
  }
}
