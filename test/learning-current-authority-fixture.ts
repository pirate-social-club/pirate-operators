// Current808 fixture composition, UNRUN. Actual Store/index/bootstrap and
// canonical proof/recovery; the existing SQLite/alarm transport is explicit.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { Store } from "../services/operator-store.ts";
import { bootstrapKey } from "../services/study-linked-withdrawal-contract.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import { telegramAuthorityStoreFixture } from "./telegram-authority-store-fixture.ts";
import { configuredWithdrawalPorts } from "../services/study-linked-withdrawal-ports.ts";
import { recoverLinkedWithdrawals } from "../services/study-linked-withdrawal-recovery.ts";
import type { WithdrawalSource } from "../services/study-linked-withdrawal-contract.ts";
import type { ResultStore } from "../services/learning-transactions.ts";

/** A source is admitted only from the fixture's actual RPC runtime. Sources
 * can be added at the test's explicit V3->V4 release; no production defaults
 * or ready/proof rows are fabricated. Recovery rebuilds its configured ports
 * from this exact retained source selection, not a stale empty JSON snapshot. */
export function currentOperatorAuthorityFixture(options: {
  now(): number;
  rpcUrl: string;
  sources?: readonly WithdrawalSource[];
  original?: ResultStore;
}) {
  const sources: WithdrawalSource[] = [...(options.sources ?? [])];
  const fixture = telegramAuthorityStoreFixture({ ...options, sources });
  // Existing receipt/privacy witnesses capture `const set = f.store.set`.
  // Keep that fixture callback ABI while invoking the actual Store method.
  fixture.store.set = fixture.store.set.bind(fixture.store);
  if (options.original && !(options.original instanceof Store))
    assert.equal(
      options.original.get(bootstrapKey),
      undefined,
      "a legacy journal cannot certify a completed production bootstrap",
    );
  if (options.original)
    fixture.store.transaction(() => {
      for (const { key, value } of options.original!.entries(""))
        fixture.store.set(key, value);
    });
  return {
    ...fixture,
    async initialize() {
      // A restored ready checkpoint still needs a genuine durable earliest wake.
      await fixture.bootstrapPage();
      await fixture.initialize();
    },
    async selectV4(communityId: Hex, contract: Address, chainId = 31337) {
      const client = createPublicClient({ transport: http(options.rpcUrl) });
      assert.equal(await client.getChainId(), chainId);
      const [code, version, originalCommunity] = await Promise.all([
        client.getCode({ address: contract }),
        client.readContract({
          address: contract,
          abi: resultsV4Abi,
          functionName: "VERSION",
        }),
        client.readContract({
          address: contract,
          abi: resultsV4Abi,
          functionName: "communityId",
        }),
      ]);
      assert.ok(code && code !== "0x", "fixture admitted runtime missing");
      assert.equal(Number(version), 4);
      assert.equal(originalCommunity.toLowerCase(), communityId.toLowerCase());
      const source: WithdrawalSource = {
        communityId,
        target: {
          version: 4,
          chainId,
          contract: contract.toLowerCase() as Address,
        },
        runtimeCodeHash: keccak256(code),
      };
      const prior = sources.find(
        (entry) =>
          entry.communityId === communityId &&
          entry.target.chainId === chainId &&
          entry.target.contract === source.target.contract,
      );
      if (prior)
        assert.deepEqual(prior, source, "fixture original source changed");
      else sources.push(source);
      await fixture.initialize();
      return source;
    },
    recover: () =>
      recoverLinkedWithdrawals(
        fixture.store,
        configuredWithdrawalPorts(
          {
            RPC_URL: options.rpcUrl,
            STUDY_WITHDRAWAL_SOURCES_JSON: JSON.stringify(sources),
          },
          fixture.store,
        ),
      ),
  };
}

/** Explicit positive-fixture dependency. Uses the actual current numbered
 * migration and the same pinned Alchemy SQLite parser as authorityD1Fixture.
 * Never split trigger bodies on semicolons or seed a completed authority row.
 * Existing selected runtimes are checked, not migrated twice. */
export async function currentAuthoritySchema(db: D1Database) {
  const sql = await readFile(
    new URL(
      "../apps/community-wizard/infra/migrations/0018_learning_authority.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const existing = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='learning_authority_heads'",
    )
    .first();
  if (!existing) {
    const wizard = createRequire(
      new URL("../apps/community-wizard/package.json", import.meta.url),
    );
    const cloudflare = wizard.resolve("@alchemy.run/cloudflare/D1/Database");
    const owned = createRequire(cloudflare);
    const sqlEntry = owned.resolve("@alchemy.run/sql/SqlFile");
    for (const file of [
      resolve(dirname(cloudflare), "../../package.json"),
      resolve(dirname(sqlEntry), "../package.json"),
    ])
      assert.equal(
        JSON.parse(await readFile(file, "utf8")).version,
        "2.0.0-beta.85",
      );
    const parser = await import(pathToFileURL(sqlEntry).href);
    const engine = await import(
      pathToFileURL(owned.resolve("@alchemy.run/sql/Migrations")).href
    );
    const transport = await import(
      pathToFileURL(resolve(dirname(cloudflare), "ApplyMigrations.js")).href
    );
    const executor = transport.makeD1MigrationExecutor((statement: string) =>
      Effect.tryPromise({
        try: async () => ({
          result: await db.batch(
            parser
              .splitSqliteStatements(statement)
              .map((part: string) => db.prepare(part)),
          ),
        }),
        catch: (cause) => cause,
      }),
    );
    const name = "0018_learning_authority.sql";
    await Effect.runPromise(
      engine.applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records: [
          {
            name,
            hash: createHash("sha256").update(sql).digest("hex"),
            createdAtMillis: engine.timestampPrefixMillis(name),
            sql,
            statements: parser.splitSqlStatements(sql),
          },
        ],
      }),
    );
  }
  const declared = [
    ...sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi,
    ),
  ].map((match) => ({ type: match[1]!.toLowerCase(), name: match[2]! }));
  const objects = (
    await db
      .prepare("SELECT type,name FROM sqlite_master")
      .all<{ type: string; name: string }>()
  ).results;
  for (const expected of declared)
    assert.ok(
      objects.some(
        (row) => row.name === expected.name && row.type === expected.type,
      ),
      `current authority schema missing ${expected.type} ${expected.name}`,
    );
  await db
    .prepare("SELECT authority_epoch FROM learning_authorizations LIMIT 0")
    .all();
  await db
    .prepare("SELECT authority_epoch FROM login_challenges LIMIT 0")
    .all();
}
