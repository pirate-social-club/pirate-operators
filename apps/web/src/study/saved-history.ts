// App-owned saved-history producer. Retains identity metadata, never a disposed
// Study client/action. Same-origin cookies and the server own private authority.
import { createEffect, createSignal, onCleanup } from "solid-js";
import { learningRequest } from "../karaoke/operator-learning-http.ts";

export interface StudyHistorySession {
  communityId: string;
  wallet: string;
  authorId: string;
  csrf: string;
}
export interface StudyHistoryOwner extends StudyHistorySession {
  accountId: string;
}
const sameSession = (a: StudyHistorySession, b: StudyHistorySession) =>
  a.communityId === b.communityId &&
  a.wallet.toLowerCase() === b.wallet.toLowerCase() &&
  a.authorId === b.authorId &&
  a.csrf === b.csrf;
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export function createSavedStudyHistory(
  session: () => StudyHistorySession | null,
  owner: () => StudyHistoryOwner | null,
) {
  const [saved, setSaved] = createSignal<
    | (StudyHistorySession & {
        lessonId: string;
        postId: string;
        accountId: string | null;
      })
    | null
  >(null);
  let active = true;
  createEffect(
    () => ({ value: saved(), auth: session(), privateOwner: owner() }),
    ({ value, auth, privateOwner }) => {
      if (!value) return;
      if (!auth || !sameSession(value, auth)) {
        setSaved(null);
        return;
      }
      // A temporarily unavailable profile does not manufacture an owner. Bind
      // once when the actual private UUID arrives; never rebind to another one.
      if (
        !privateOwner ||
        !uuid(privateOwner.accountId) ||
        !sameSession(value, privateOwner)
      )
        return;
      if (value.accountId === null)
        setSaved({ ...value, accountId: privateOwner.accountId });
      else if (value.accountId !== privateOwner.accountId) setSaved(null);
    },
  );
  onCleanup(() => {
    active = false;
    setSaved(null);
  });
  const available = () => {
    const value = saved(),
      auth = session(),
      privateOwner = owner();
    return !!(
      active &&
      value?.accountId &&
      auth &&
      privateOwner &&
      uuid(privateOwner.accountId) &&
      sameSession(value, auth) &&
      sameSession(value, privateOwner) &&
      value.accountId === privateOwner.accountId
    );
  };
  return {
    available,
    remember(lessonId: string, postId: string) {
      const auth = session();
      if (!active || !auth || !/^[a-zA-Z0-9_-]{16,128}$/.test(lessonId)) return;
      const prior = saved();
      if (
        prior &&
        prior.lessonId === lessonId &&
        prior.postId === postId &&
        sameSession(prior, auth)
      )
        return;
      const privateOwner = owner();
      setSaved({
        ...auth,
        lessonId,
        postId,
        accountId:
          privateOwner &&
          uuid(privateOwner.accountId) &&
          sameSession(auth, privateOwner)
            ? privateOwner.accountId
            : null,
      });
    },
    async download() {
      const selected = saved();
      const current = () => active && saved() === selected && available();
      if (!selected || !current())
        throw new Error("Private history is unavailable for this account.");
      const history = await learningRequest<{
        schema?: string;
        communityId?: string;
        lesson?: { lessonId?: string };
      }>(
        `/api/study/lessons/${encodeURIComponent(selected.lessonId)}/history`,
        { account: selected.wallet, csrf: selected.csrf, body: {} },
      ).catch((error: { code?: string; status?: number }) => {
        if (
          active &&
          saved() === selected &&
          (error.code === "study_account_changed" ||
            (error.code === "learning_session_unavailable" &&
              (error.status === 401 || error.status === 403)))
        )
          setSaved(null);
        throw error;
      });
      if (!current())
        throw new Error("Private history is unavailable for this account.");
      if (
        history?.schema !== "pirate.study-private-history/1" ||
        history.communityId !== selected.communityId ||
        history.lesson?.lessonId !== selected.lessonId
      )
        throw new Error("Private history could not be downloaded. Try again.");
      // Preserve the complete server download, including retention/expiry and
      // private transcript fields. It is never rendered as public page data.
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(history, null, 2)], {
          type: "application/json",
        }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `study-history-${selected.lessonId}.json`;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
