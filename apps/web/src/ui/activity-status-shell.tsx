import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Type } from "../design-system.ts";
import { ActivityProgressHeader } from "../karaoke/activity-progress-header.tsx";
import { ActivityFooter } from "./activity-footer.tsx";
import { ErrorState, type ErrorStateAction, type ErrorStateTone } from "./error-state.tsx";

export interface ActivityStatusShellProps {
  title: string;
  description: string;
  label?: string;
  tone?: ErrorStateTone;
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
    <div class="flex h-dvh min-h-0 w-full flex-col overflow-y-auto bg-background text-foreground">
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
      <section aria-label={props.label} class="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-4 px-4 py-8 sm:px-6">
        <ErrorState
          description={props.description}
          status={props.status}
          title={props.title}
          tone={props.tone}
        />
        <Show when={props.notice}>
          {(notice) => <Type role="alert" variant="caption">{notice()}</Type>}
        </Show>
      </section>
      <ActivityFooter
        onPrimaryAction={props.primaryAction?.onClick}
        onSecondaryAction={props.secondaryAction?.onClick}
        primaryDisabled={props.primaryDisabled || props.primaryAction?.disabled}
        primaryIcon={props.primaryIcon}
        primaryLabel={props.primaryAction?.label}
        primaryLoading={props.primaryLoading}
        primaryVariant="default"
        secondaryLabel={props.secondaryAction?.label}
      />
    </div>
  );
}
