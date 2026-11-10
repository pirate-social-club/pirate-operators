import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { TelegramLoginBroker } from "../services/telegram-broker.ts";
import {
  base64url,
  randomToken,
  sha256,
} from "../packages/telegram/security.ts";
import {
  TelegramError,
  type ChatActor,
  type WebAccount,
} from "../packages/telegram/contracts.ts";

export const communityId = "0x" + "a".repeat(64);
export const actor: ChatActor = {
  communityId,
  botId: "90001",
  generation: 1,
  userId: "70001",
  chatId: "70001",
};
export const account: WebAccount = {
  communityId,
  accountId: "learner-account",
  wallet: "0x" + "1".repeat(40),
  authorityVersion: "authority-1",
  sessionId: "session-1",
};
export function journalFixture(path = ":memory:") {
  const database = new DatabaseSync(path);
  let depth = 0;
  const storage = {
    sql: {
      exec(sql: string, ...bindings: (string | number | null)[]) {
        const rows = database.prepare(sql).all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    transactionSync<T>(operation: () => T): T {
      const savepoint = "telegram_" + depth++;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = operation();
        database.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        depth--;
      }
    },
  } as unknown as Pick<DurableObjectStorage, "sql" | "transactionSync">;
  return {
    store: new TelegramSqlJournal(storage),
    storage,
    database,
    close: () => database.close(),
  };
}
export function sqlitePath(label: string) {
  mkdirSync(join(process.cwd(), ".local/tmp"), { recursive: true });
  return join(
    process.cwd(),
    ".local/tmp",
    `telegram-${label}-${crypto.randomUUID()}.sqlite`,
  );
}
export async function linkFixture(path = ":memory:") {
  const journal = journalFixture(path),
    brokerJournal = journalFixture();
  let clock = 1794355200000,
    enabled = true,
    authorityVersion = account.authorityVersion;
  const grants = new TelegramGrants(
    journal.store,
    {
      async current(comm, id) {
        if (!enabled || comm !== communityId || id !== account.accountId)
          throw new TelegramError("account_disabled", 403);
        return {
          accountId: account.accountId,
          wallet: account.wallet,
          authorityVersion,
        };
      },
    },
    () => clock,
  );
  grants.configure({
    communityId,
    botId: actor.botId,
    generation: 1,
    enabled: true,
  });
  grants.start(actor);
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "local-test-key",
    alg: "RS256",
    use: "sig",
  };
  let nonce = "",
    challenge = "",
    exchangeCalls = 0,
    unknownExchange = false;
  let overrides: Record<string, unknown> = {};
  const providerReceipts = new Map<string, string>();
  async function token(
    changes = overrides,
    headerChanges: Record<string, unknown> = {},
  ) {
    const header = base64url(
      new TextEncoder().encode(
        JSON.stringify({
          alg: "RS256",
          kid: "local-test-key",
          typ: "JWT",
          ...headerChanges,
        }),
      ),
    );
    const payload = base64url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: "https://oauth.telegram.org",
          aud: "telegram-login-client",
          sub: "oidc-subject",
          id: Number(actor.userId),
          nonce,
          iat: Math.floor(clock / 1000),
          exp: Math.floor(clock / 1000) + 300,
          ...changes,
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(header + "." + payload),
    );
    return header + "." + payload + "." + base64url(new Uint8Array(signature));
  }
  const broker = new TelegramLoginBroker(
    brokerJournal.store,
    {
      origin: "https://login.example",
      redirectUri: "https://login.example/telegram/oidc/callback",
      oidcClientId: "telegram-login-client",
      clients: [
        {
          id: "community-client",
          communityId,
          returnUrl: "https://community.example/telegram/connect/return",
          secretHash: await sha256("local-simulated-client-secret"),
        },
      ],
    },
    {
      async exchange(input) {
        exchangeCalls++;
        if (
          (await sha256(input.verifier)) !== challenge ||
          input.redirectUri !== broker.redirectUri
        )
          throw new Error("fixture_pkce_mismatch");
        const signed = await token();
        providerReceipts.set(input.requestId, signed);
        if (unknownExchange) throw new Error("simulated_unknown_exchange");
        return signed;
      },
      recover: async (id) => providerReceipts.get(id) ?? null,
      jwks: async () => [publicKey],
    },
    () => clock,
  );
  const brokerPort = {
    request: (input) => broker.request("community-client", input),
    redeem: (input) => broker.redeem("community-client", input),
  } satisfies import("../packages/telegram/link-contracts.ts").TelegramBrokerPort;
  const linking = new TelegramLinking(
    grants,
    brokerPort,
    "community-client",
    "https://community.example/telegram/connect/return",
  );
  async function begin(who = actor, web = account) {
    grants.start(who);
    const browser = randomToken(),
      brokerBrowser = randomToken();
    const reference = await linking.pending(who),
      transaction = await linking.create(reference, web, browser);
    const navigation = await linking.open(transaction.id, web, browser);
    const started = await broker.begin(
      new URL(navigation.navigationUrl).searchParams.get("handle")!,
      brokerBrowser,
    );
    const authorization = new URL(started.authorizationUrl);
    nonce = authorization.searchParams.get("nonce")!;
    challenge = authorization.searchParams.get("code_challenge")!;
    return {
      browser,
      brokerBrowser,
      reference,
      transaction,
      authorization,
      state: authorization.searchParams.get("state")!,
    };
  }
  async function verify(flow: Awaited<ReturnType<typeof begin>>) {
    return new URL(
      (
        await broker.callback(
          flow.state,
          "fixture-provider-code",
          flow.brokerBrowser,
        )
      ).returnUrl,
    );
  }
  async function complete(
    flow: Awaited<ReturnType<typeof begin>>,
    returned: URL,
  ) {
    return linking.complete(
      flow.transaction.id,
      returned.searchParams.get("state")!,
      returned.searchParams.get("code")!,
      account,
      flow.browser,
    );
  }
  return {
    ...journal,
    brokerJournal,
    grants,
    broker,
    brokerPort,
    linking,
    begin,
    verify,
    complete,
    token,
    publicKey,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    authority: (value: string) => {
      authorityVersion = value;
    },
    claims: (value: Record<string, unknown>) => {
      overrides = value;
    },
    unknown: (value = true) => {
      unknownExchange = value;
    },
    exchangeCalls: () => exchangeCalls,
    dispose: () => {
      journal.close();
      brokerJournal.close();
    },
  };
}
