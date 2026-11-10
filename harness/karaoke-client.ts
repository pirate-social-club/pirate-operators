import type { PrivateKeyAccount } from "viem/accounts";
import type { Miniflare } from "miniflare";
import type { Signed } from "../packages/protocol/index.ts";
import type {
  AttemptStart,
  SignedPurchase,
} from "../packages/protocol/payments.ts";

export interface Posted<T = unknown> {
  status: number;
  value: T;
}
/** Context for fixture failures, without query proofs, headers or payloads. */
async function localRequest<T>(
  role: string,
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const target = ["community", "operator", "very", "elevenlabs"].includes(
      role,
    )
      ? role
      : "local";
    const pathname = new URL(path, "http://fixture.invalid").pathname;
    throw new Error(`local_worker_request_failed:${target}:${pathname}`, {
      cause,
    });
  }
}
/** One JSON POST to a local worker; callers decide which statuses they expect. */
export async function post<T = unknown>(
  mf: Miniflare,
  role: string,
  path: string,
  input: unknown,
  session?: string,
): Promise<Posted<T>> {
  return localRequest(role, path, async () => {
    const worker = await mf.getWorker(role);
    const response = await worker.fetch(`http://${role}.localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: (await response.json()) as T };
  });
}

export interface Message {
  type: string;
  code?: string;
  attemptStart?: Signed<AttemptStart>;
  resumed?: boolean;
  segmentId?: string;
  [key: string]: unknown;
}
/** Opens the operator's karaoke socket with the skeleton's session-key proof. */
export async function openAttempt(
  mf: Miniflare,
  ticketId: string,
  /** The session key, or a connection proof its holder issued. */
  sessionKey: PrivateKeyAccount | { proof: string },
) {
  const proof =
    "proof" in sessionKey
      ? sessionKey.proof
      : await sessionKey.signMessage({ message: `connect:${ticketId}` });
  const response = await localRequest("operator", "/attempt", async () => {
    const worker = await mf.getWorker("operator");
    return worker.fetch(
      `http://operator.localhost/attempt?ticketId=${ticketId}&proof=${proof}`,
      { headers: { Upgrade: "websocket" } },
    );
  });
  if (response.status !== 101)
    return { refused: (await response.json()) as { error: string } };
  const ws = response.webSocket!;
  const queue: Message[] = [];
  const waiters: ((m: Message) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  ws.accept();
  const next = () =>
    new Promise<Message>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(
        () => reject(new Error("socket_timeout")),
        10000,
      );
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const send = (value: unknown) => ws.send(JSON.stringify(value));
  const ready = await next();
  if (ready.type !== "ready")
    throw new Error(`expected_ready:${JSON.stringify(ready)}`);
  return {
    ws,
    ready,
    next,
    send,
    /** Sends a signed purchase on the socket and waits for the operator's answer. */
    async pay(purchase: SignedPurchase) {
      send({ type: "purchase", ...purchase });
      return next();
    },
    close: () => ws.close(1000, "done"),
  };
}
export type Attempt = Exclude<
  Awaited<ReturnType<typeof openAttempt>>,
  { refused: unknown }
>;

/** Asks the community to sign the purchase for one segment, take 0. */
export const requestPurchase = (
  mf: Miniflare,
  session: string,
  ticketId: string,
  segmentId: string,
  attemptStart?: Signed<AttemptStart>,
) =>
  post<SignedPurchase & { error?: string }>(
    mf,
    "community",
    "/karaoke/purchases",
    { ticketId, segmentId, take: 0, ...(attemptStart ? { attemptStart } : {}) },
    session,
  );
