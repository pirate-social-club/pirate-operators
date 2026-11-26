// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-states.tsx; imports and Learning frame ownership changed.
import { Spinner, Type } from "../ui.ts";
import { ActivityProgressHeader } from "../../ui/activity-progress-header.tsx";
import { ActivityFooter } from "../../ui/activity-footer.tsx";
import { LearningActivityFrame } from "../../ui/learning-activity-frame.tsx";

function StudyFrameHeader(props: { onExit?: () => void }) {
  return (
    <div data-study-header>
      <ActivityProgressHeader
        exitIcon="close"
        exitLabel="Exit study"
        onExit={props.onExit}
        progressTone="success"
      />
    </div>
  );
}

export interface StudyRouteLoadingStateProps {
  label?: string;
  onExit?: () => void;
}

export function StudyRouteLoadingState(props: StudyRouteLoadingStateProps) {
  return (
    <LearningActivityFrame
      as="section"
      header={props.onExit ? <StudyFrameHeader onExit={props.onExit} /> : undefined}
      contentClass="items-center justify-center"
    >
      <div
        aria-busy="true"
        aria-label={props.label ?? "Loading"}
        role="status"
      >
        <Spinner class="size-6 text-muted-foreground" decorative />
      </div>
    </LearningActivityFrame>
  );
}

export interface StudyRouteLoadFailureStateProps {
  description: string;
  onGoHome?: () => void;
  onRetry?: () => void;
  title: string;
}

export function StudyRouteLoadFailureState(props: StudyRouteLoadFailureStateProps) {
  return (
    <LearningActivityFrame
      as="section"
      header={props.onGoHome ? <StudyFrameHeader onExit={props.onGoHome} /> : undefined}
      footer={(
        <ActivityFooter
          onPrimaryAction={() => props.onRetry?.()}
          onSecondaryAction={() => props.onGoHome?.()}
          primaryLabel="Try Again"
          secondaryLabel="Go Home"
        />
      )}
    >
      <div class="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <div class="flex w-full max-w-[350px] flex-col items-center text-center">
          <Type as="h1" class="text-xl" variant="h4">
            {props.title}
          </Type>
          <Type as="p" class="mt-3 text-muted-foreground" variant="body">
            {props.description}
          </Type>
        </div>
      </div>
    </LearningActivityFrame>
  );
}

export interface StudyAuthRequiredStateProps {
  ctaLabel?: string;
  description: string;
  onConnect?: () => void;
  onConnectIntent?: () => void;
  onConnectPreload?: () => void;
  onExit?: () => void;
  title: string;
}

export function StudyAuthRequiredState(props: StudyAuthRequiredStateProps) {
  return (
    <LearningActivityFrame
      as="section"
      header={props.onExit ? <StudyFrameHeader onExit={props.onExit} /> : undefined}
      footer={props.onConnect ? (
        <ActivityFooter
          onPrimaryAction={() => props.onConnect?.()}
          onPrimaryFocus={props.onConnectIntent}
          onPrimaryPointerDown={props.onConnectIntent}
          onPrimaryPointerEnter={props.onConnectPreload}
          primaryLabel={props.ctaLabel ?? "Sign in"}
        />
      ) : undefined}
    >
      <div class="flex flex-1 flex-col px-5 pt-6">
        <Type as="h1" class="text-lg" variant="h4">
          {props.title}
        </Type>
        <Type as="h2" class="mt-6 text-base" variant="body-strong">
          Sign in
        </Type>
        <Type as="p" class="mt-1 max-w-[350px] text-[15px] leading-5 text-muted-foreground" variant="body">
          {props.description}
        </Type>
      </div>
    </LearningActivityFrame>
  );
}
