import type {
  Web2ActionView,
  Web2WizardView,
} from "../server/web2-setup.ts";
export type { Web2WizardView };
export interface Web2Snapshot {
  available: true;
  csrf: string;
  /** The action view: storage action replies carry their typed outcome here,
   * part of the public contract rather than a cast. */
  view: Web2ActionView;
}
export type Web2Action =
  | "prepare"
  | "resume-prepare"
  | "authorize"
  | "redeem"
  | "reconcile"
  | "topup"
  | "publishing-prepare"
  | "publishing-authorize"
  | "publishing-attach"
  | "publishing-reconcile"
  | "installation-prepare"
  | "install"
  | "installation-status"
  | "storage-save"
  | "storage-check"
  | "storage-reconcile"
  | "dns-select"
  | "dns-check";
const actions: readonly string[] = [
  "prepare",
  "resume-prepare",
  "authorize",
  "redeem",
  "reconcile",
  "topup",
  "publishing-prepare",
  "publishing-authorize",
  "publishing-attach",
  "publishing-reconcile",
  "installation-prepare",
  "install",
  "installation-status",
  "storage-save",
  "storage-check",
  "storage-reconcile",
  "dns-select",
  "dns-check",
];
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function createWeb2WizardClient(
  transport: typeof fetch = (...args) => globalThis.fetch(...args),
) {
  async function request(
    action?: Web2Action,
    input: Record<string, unknown> = {},
    current?: Web2Snapshot,
  ): Promise<Web2Snapshot> {
    if (
      action &&
      (!actions.includes(action) ||
        !current ||
        !/^[a-f0-9]{64}$/.test(current.csrf))
    )
      throw Error("Reload the original paired runner before continuing.");
    const bytes = JSON.stringify({
      ...input,
      ...(action ? { revision: current!.view.revision } : {}),
    });
    if (new TextEncoder().encode(bytes).length > 196608)
      throw Error("This request exceeds the setup limit.");
    let response: Response;
    try {
      response = await transport("/api/web2/" + (action ?? "state"), {
        method: action ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: action
          ? {
              "Content-Type": "application/json",
              "X-Wizard-Token": current!.csrf,
            }
          : {},
        ...(action ? { body: bytes } : {}),
        signal: AbortSignal.timeout(
          action === "installation-prepare" ||
            action === "install" ||
            action === "installation-status"
            ? 180_000
            : 30_000,
        ),
      });
    } catch {
      throw Error(
        "The reply is unknown. Reload and reconcile the original request before retrying.",
      );
    }
    if (!response.body)
      throw Error(
        "The runner returned an incomplete response. Retain the original request.",
      );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 262144) {
          await reader.cancel();
          throw Error("The runner response exceeds the setup limit.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch {
      throw Error(
        "The runner reply is incomplete. Reconcile the original request.",
      );
    }
    if (!response.ok)
      throw Error(
        record(value) && typeof value.error === "string"
          ? value.error
          : "The step is unavailable. Retain the original request.",
      );
    if (
      !record(value) ||
      value.available !== true ||
      typeof value.csrf !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.csrf) ||
      !record(value.view) ||
      value.view.schema !== "pirate.web2-wizard-view/1" ||
      !Number.isSafeInteger(value.view.revision) ||
      typeof value.view.phase !== "string" ||
      typeof value.view.busy !== "boolean" ||
      !Array.isArray(value.view.recipients)
    )
      throw Error(
        "This runner serves an incompatible setup model. Retain its original state.",
      );
    return value as unknown as Web2Snapshot;
  }
  return {
    state: () => request(),
    send: (
      action: Web2Action,
      input: Record<string, unknown>,
      current: Web2Snapshot,
    ) => request(action, input, current),
  };
}
