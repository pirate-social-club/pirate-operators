import { createMemo, onCleanup, Show } from "solid-js";
import { StudyPage } from "../study/page.tsx";
import { KaraokePage } from "../karaoke/page.tsx";
import type { KaraokeHistoryTicket } from "../karaoke/saved-history.ts";
import type { KaraokeWallet } from "./learning-consent.ts";
import type { LearningActionOwner } from "./learning-action-owner.ts";

export interface LearningPageRoute {
  kind: "study" | "sing";
  postId: string;
  title: string;
  lessonId?: string;
}
export interface LearningPageMountProps {
  communityId: string;
  route: LearningPageRoute | null;
  account: string | null;
  csrf: string;
  wallet: KaraokeWallet;
  serviceMode?: "internal";
  signInPermission: boolean;
  actions: LearningActionOwner;
  onExit(): void;
  onConnect(): void;
  onLessonOpened(lessonId: string): void;
  historyGeneration?: number;
  onKaraokeHistory?: (
    ticket: KaraokeHistoryTicket | null,
    generation: number,
  ) => void;
}

/** A new URL, session or community disposes the original page/controller. */
export function LearningPageMount(props: LearningPageMountProps) {
  const snapshot = createMemo(() => {
    const route = props.route;
    return route && props.communityId
      ? {
          route: { ...route },
          communityId: props.communityId,
          account: props.account,
          csrf: props.csrf,
          signInPermission: props.signInPermission,
          serviceMode: props.serviceMode,
          historyGeneration: props.historyGeneration ?? 0,
        }
      : null;
  });
  return (
    <Show when={snapshot()} keyed>
      {(owner) => {
        const lease = props.actions.claim();
        onCleanup(lease.release);
        const onLessonOpened = (lessonId: string) => {
          if (lease.current()) props.onLessonOpened(lessonId);
        };
        return (
          <div
            class={
              owner.route.kind === "study"
                ? "live-study-overlay"
                : "live-karaoke-overlay"
            }
          >
            <Show
              when={owner.route.kind === "study"}
              fallback={
                <KaraokePage
                  communityId={owner.communityId}
                  onHistoryTicket={(ticket) => {
                    if (!lease.current()) return;
                    if (
                      ticket &&
                      (ticket.communityId !== owner.communityId ||
                        ticket.postId !== owner.route.postId ||
                        ticket.wallet !== owner.account?.toLowerCase())
                    )
                      return;
                    props.onKaraokeHistory?.(ticket, owner.historyGeneration);
                  }}
                  account={owner.account}
                  postId={owner.route.postId}
                  title={owner.route.title}
                  csrf={owner.csrf}
                  wallet={props.wallet}
                  serviceMode={owner.serviceMode}
                  signInPermission={owner.signInPermission}
                  onExit={props.onExit}
                  onConnect={props.onConnect}
                  onLearningActions={lease.publish}
                />
              }
            >
              <StudyPage
                account={owner.account}
                postId={owner.route.postId}
                title={owner.route.title}
                csrf={owner.csrf}
                wallet={props.wallet}
                lessonId={owner.route.lessonId}
                signInPermission={owner.signInPermission}
                onExit={props.onExit}
                onConnect={props.onConnect}
                onLessonOpened={onLessonOpened}
                onLearningActions={lease.publish}
              />
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
