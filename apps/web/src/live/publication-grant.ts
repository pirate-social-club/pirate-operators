import { sha256, type Hex } from "viem";
import { preparePublicationGrant, type PublicationPurpose } from "../../../../packages/protocol/publication-consent.ts";
import type { ConsentCommandReceiptV1, CurrentGrantStateV1, PreparedConsentCommandV1, PublicationPermissionViewV1 } from "../../../../packages/protocol/publication-runtime-v1.ts";
import { publicationConsentTypes } from "../../../../packages/protocol/generated/publication-consent-v1.ts";
import { CommunityRequestError } from "./api.ts";
import { publicationGrantAttempt, type PublicationGrantAttempt } from "./publication-grant-journal.ts";

const prefix = "/api/publication-consent/v1/";
const commandKey = /^0x[0-9a-f]{64}$/;
const accountKey = /^0x[0-9a-f]{40}$/;
const signedBytes = /^0x(?:[0-9a-f]{2})+$/;
const documentNames = ["terms", "disclosure", "privacy", "retention"] as const;
type Documents = Record<"manifest" | (typeof documentNames)[number], string>;
type Grant = Extract<PreparedConsentCommandV1, { action: "grant" }>;
export interface PublicationGrantScope {
  origin: string;
  communityId: string;
  authorId: string;
  wallet: string;
  purpose: PublicationPurpose;
}
interface Original {
  commandId: Hex;
  phase: "preparing" | "prepared" | "accepted";
  command: PreparedConsentCommandV1 | null;
  receipt: ConsentCommandReceiptV1 | null;
  documents?: Documents;
  currentGrant?: CurrentGrantStateV1;
}
export type PublicationGrantReview = {
  command: Grant;
  documents: Documents;
};
export function publicationWalletRequest(command: Grant) {
  return {
    domain: {
      name: "Pirate Publication Consent", version: "1", chainId: command.source.chainId,
      verifyingContract: command.source.registry,
    },
    primaryType: "PublicationGrant" as const,
    types: publicationConsentTypes,
    message: command.message,
  };
}
export type PublicationGrantStatus =
  | { kind: "empty" | "prepare" | "resume" | "signed" | "pending" | "recorded" | "unavailable" | "refused" | "expired" }
  | { kind: "review"; review: PublicationGrantReview };

type Ports = {
  csrf(): string;
  current(): void;
  sign(review: PublicationGrantReview): Promise<Hex | null>;
};

/** The journal owns one current intent per account and purpose. Web Locks
 * prevent two tabs opening wallet prompts for the same original. */
export function publicationGrant(scope: Readonly<PublicationGrantScope>, ports: Ports) {
  const key = JSON.stringify([scope.origin, scope.communityId, scope.authorId, scope.wallet, scope.purpose]);
  async function exchange<T = Original>(path: string, body?: object): Promise<T> {
    ports.current();
    const response = await fetch(prefix + path, {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(35_000),
      ...(body ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ports.csrf() }, body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    ports.current();
    if (!response.ok) throw new CommunityRequestError("The publication request is unavailable.", response.status, value?.error);
    return value as T;
  }
  function verify(value: Original, attempt: PublicationGrantAttempt) {
    const { command, receipt, commandId, phase } = value;
    if (!commandKey.test(commandId) || (attempt.commandId && attempt.commandId !== commandId) ||
      !["preparing", "prepared", "accepted"].includes(phase) ||
      (command && (command.schema !== "pirate.publication-command/1" || command.action !== "grant" || command.commandId !== commandId ||
        command.requestId !== attempt.requestId || command.source.communityId !== scope.communityId ||
        command.source.schema !== "pirate.publication-source/1" || command.source.resultsVersion !== 5 ||
        command.source.chainId !== 6343 || !accountKey.test(command.source.registry) ||
        command.message.communityId !== scope.communityId || command.message.learner !== scope.wallet ||
        command.message.purpose !== scope.purpose || !commandKey.test(command.digest))) ||
      (phase !== "preparing" && !command) ||
      (receipt && (receipt.commandId !== commandId || receipt.action !== "grant" ||
        receipt.purpose !== scope.purpose || receipt.digest !== command?.digest)))
      throw Error("The publication request changed. Check the original request.");
    if (!command || command.action !== "grant") return null;
    const checked = preparePublicationGrant(6343n, command.source.registry, command.message, "0x");
    if (checked.digest !== command.digest) throw Error("The publication signature request changed.");
    return command;
  }
  async function retain(attempt: PublicationGrantAttempt, original: Original): Promise<PublicationGrantStatus> {
    verify(original, attempt);
    ports.current();
    const receipt = original.receipt?.state;
    const terminal = receipt === "recorded" ? "recorded" :
      receipt === "reverted" || receipt === "withheld" || receipt === "refused" ? "refused" : undefined;
    await publicationGrantAttempt(key, {
      requestId: attempt.requestId, commandId: original.commandId,
      ...(terminal ? { terminal } : {}),
      ...(original.phase !== "accepted" && attempt.signature ? { signature: attempt.signature } : {}),
    });
    ports.current();
    if (terminal === "recorded" && original.currentGrant?.state === "denied" && original.currentGrant.reason === "expired")
      return { kind: "expired" };
    if (terminal) return { kind: terminal };
    if (original.phase === "accepted") return { kind: "pending" };
    return { kind: attempt.signature ? "signed" : "resume" };
  }
  async function exactError(attempt: PublicationGrantAttempt, error: unknown): Promise<PublicationGrantStatus> {
    ports.current();
    if (!(error instanceof CommunityRequestError) || error.code !== "publication_original_window_expired") throw error;
    await publicationGrantAttempt(key, { requestId: attempt.requestId, commandId: attempt.commandId, terminal: "expired" });
    return { kind: "expired" };
  }
  async function findAccountOriginal(): Promise<PublicationGrantStatus | null> {
    const view = await exchange<PublicationPermissionViewV1>(`state?purpose=${scope.purpose}`);
    if (view.schema !== "pirate.publication-permission/1" || view.purpose !== scope.purpose)
      throw Error("The publication permission changed.");
    if (view.commandId === null) return view.state === "denied" && view.reason === "unknown_grant"
      ? null : { kind: "unavailable" };
    if (!commandKey.test(view.commandId)) throw Error("The publication request changed.");
    const original = await exchange(`commands/${view.commandId}`);
    if (!original.command) return { kind: "unavailable" };
    return retain({ requestId: original.command.requestId, commandId: view.commandId }, original);
  }
  function exclusive<T>(run: () => Promise<T>) {
    return navigator.locks.request("pirate-publication-grant:" + key, { ifAvailable: true }, (lock) => {
      if (!lock) throw Error("This publication request is open in another tab.");
      ports.current();
      return run();
    });
  }
  return {
    check: () => exclusive(async (): Promise<PublicationGrantStatus> => {
      const attempt = await publicationGrantAttempt(key);
      if (!attempt) return await findAccountOriginal() ?? { kind: "empty" };
      if (attempt.terminal && attempt.terminal !== "recorded") return { kind: attempt.terminal };
      if (!attempt.commandId) return { kind: "prepare" };
      return retain(attempt, await exchange(`commands/${attempt.commandId}`));
    }),
    prepare: (renew = false) => exclusive(async (): Promise<PublicationGrantStatus> => {
      let attempt = await publicationGrantAttempt(key);
      if (!attempt && !renew) {
        const existing = await findAccountOriginal();
        if (existing) return existing;
      }
      if (!attempt || (renew && attempt.terminal)) {
        if (renew && !attempt?.terminal) throw Error("Check the previous publication request first.");
        attempt = { requestId: crypto.randomUUID() };
        ports.current();
        await publicationGrantAttempt(key, attempt);
      }
      if (attempt.terminal || attempt.signature) throw Error("Check the original publication request first.");
      try {
        const original = await exchange("grants/prepare", { purpose: scope.purpose, requestId: attempt.requestId });
        const command = verify(original, attempt);
        const status = await retain(attempt, original);
        if (status.kind !== "resume") return status;
        const docs = original.documents;
        if (!command || !docs || typeof docs.manifest !== "string" || documentNames.some((name) => typeof docs[name] !== "string" || !docs[name]))
          throw Error("The publication documents are unavailable.");
        const digest = (text: string) => sha256(new TextEncoder().encode(text));
        const manifest = JSON.parse(docs.manifest);
        if (digest(docs.manifest) !== command.message.policyHash ||
          documentNames.some((name) => manifest[`${name}Sha256`] !== digest(docs[name])))
          throw Error("The publication documents changed.");
        return { kind: "review", review: { command, documents: docs } };
      } catch (error) {
        return exactError(attempt, error);
      }
    }),
    submit: (review?: PublicationGrantReview) => exclusive(async (): Promise<PublicationGrantStatus> => {
      let attempt = await publicationGrantAttempt(key);
      if (!attempt?.commandId || attempt.terminal) throw Error("Check the original publication request first.");
      const { commandId } = attempt;
      try {
        const original = await exchange(`commands/${commandId}`);
        const command = verify(original, attempt);
        if (original.phase === "accepted") return retain(attempt, original);
        if (!attempt.signature) {
          if (!review || !command || command.digest !== review.command.digest ||
            JSON.stringify(command) !== JSON.stringify(review.command))
            throw Error("Review the original publication request before signing.");
          ports.current();
          const signature = await ports.sign(review);
          ports.current();
          if (signature === null) return { kind: "review", review };
          if (!signedBytes.test(signature)) throw Error("MOSS did not return a valid signature.");
          attempt = { ...attempt, signature };
          // A lost response can replay the exact accepted bytes without another wallet prompt.
          await publicationGrantAttempt(key, attempt);
        }
        const accepted = await exchange(`commands/${commandId}/submit`, { signature: attempt.signature });
        return retain(attempt, accepted);
      } catch (error) {
        return exactError(attempt, error);
      }
    }),
  };
}
