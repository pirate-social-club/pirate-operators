import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Spinner, Type } from "../design-system.ts";
import { ActivityProgressHeader } from "./activity-progress-header.tsx";
import { ActivityFooter } from "./activity-footer.tsx";
import { ErrorState, type ErrorStateAction, type ErrorStateTone } from "./error-state.tsx";
import { LearningActivityFrame } from "./learning-activity-frame.tsx";

export interface ActivityStatusShellProps {
  title: string;
  description?: string;
  loading?: boolean;
  asMain?: boolean;
  mainLabel?: string;
  label?: string;
  tone?: ErrorStateTone;
  error?: boolean;
  status?: string;
  notice?: string;
  onExit?: () => void;
  exitLabel?: string;
  exitIcon?: "back" | "close";
  progressMax?: number;
  progressValue?: number;
  progressTone?: "success" | "warning";
  rewardLabel?: string;
  rewardPresentation?: "badge" | "icon";
  primaryAction?: ErrorStateAction;
  secondaryAction?: ErrorStateAction;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryIcon?: JSX.Element;
}

/** Standard activity page chrome for loading, blocked and recovery states. */
export function ActivityStatusShell(props: ActivityStatusShellProps) {
  return (
    <LearningActivityFrame
      as={props.asMain ? "main" : "div"}
      ariaBusy={props.loading}
      ariaLabel={props.asMain ? props.mainLabel : undefined}
      header={(
        <ActivityProgressHeader
          exitIcon={props.exitIcon}
          exitLabel={props.exitLabel}
          onExit={props.onExit}
          progressMax={props.progressMax}
          progressTone={props.progressTone}
          progressValue={props.progressValue}
          rewardLabel={props.rewardLabel}
          rewardPresentation={props.rewardPresentation}
        />
      )}
      footer={props.primaryAction?.label ? (
        <ActivityFooter
          onPrimaryAction={props.primaryAction.onClick}
          onSecondaryAction={props.secondaryAction?.onClick}
          primaryDisabled={props.primaryDisabled || props.primaryAction.disabled}
          primaryIcon={props.primaryIcon}
          primaryLabel={props.primaryAction.label}
          primaryLoading={props.primaryLoading}
          primaryVariant="default"
          secondaryLabel={props.secondaryAction?.label}
        />
      ) : undefined}
    >
      <section aria-label={props.label} class="flex flex-1 flex-col justify-center gap-4 px-4 py-8 sm:px-6">
        <Show
          when={props.loading}
          fallback={
            <ErrorState
              description={props.description}
              status={props.status}
              title={props.title}
              tone={props.tone}
              error={props.error}
              centered
              headingLevel={props.asMain ? "h1" : "h2"}
            />
          }
        >
          <div class="flex flex-col items-center gap-3 text-center" role="status">
            <Type as={props.asMain ? "h1" : "h2"} variant="h3">{props.title}</Type>
            <Spinner class="size-5" decorative />
          </div>
        </Show>
        <Show when={props.notice}>
          {(notice) => <Type role="alert" variant="caption">{notice()}</Type>}
        </Show>
      </section>
    </LearningActivityFrame>
  );
}
