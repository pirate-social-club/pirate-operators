import { exact, insist, integer, object } from "../../packages/community/common.ts";

export interface Web2OperatorDraft {
  name: string;
  origin: string;
  controller: string;
  owner: string;
  invite: string;
}

export interface Web2OperatorDraftSnapshot {
  revision: number;
  fields: Web2OperatorDraft | null;
}

// The draft accepts partial editing input. Prepare validates the complete original.
export function web2OperatorDraftFrom(input: unknown): Web2OperatorDraft {
  const value = object(input);
  exact(value, ["name", "origin", "controller", "owner", "invite"]);
  function field(key: keyof Web2OperatorDraft, limit: number) {
    const valueForField = value[key];
    insist(typeof valueForField === "string" && valueForField.length <= limit &&
      !/[\u0000-\u001f\u007f]/.test(valueForField), "web2_operator_draft_invalid");
    return valueForField;
  }
  const draft = {
    name: field("name", 63),
    origin: field("origin", 300),
    controller: field("controller", 42),
    owner: field("owner", 42),
    invite: field("invite", 64),
  };
  insist(draft.controller === "" || /^0x[a-f0-9]{40}$/.test(draft.controller), "web2_operator_draft_invalid");
  return draft;
}

export function web2OperatorDraftSnapshotFrom(input: unknown): Web2OperatorDraftSnapshot {
  const value = object(input);
  exact(value, ["revision", "fields"]);
  return {
    revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER),
    fields: value.fields === null ? null : web2OperatorDraftFrom(value.fields),
  };
}
