import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import {
  Button,
  CardContent,
  Checkbox,
  CheckboxLabel,
  FormNote,
  RadioGroup,
  RadioGroupItem,
  Type,
  cn,
} from "../reference/src/design-system.ts";
import type { PostComposerController } from "../reference/src/features/posts/post-composer/controller.ts";
import type {
  PostComposerProps,
  SongFlowRuntime,
} from "../reference/src/features/posts/post-composer/types.ts";
import type { ComposerSteps } from "../reference/src/features/posts/post-composer/composer-steps.ts";
import { OWNER_RELEASE_POLICY } from "../community-contracts.ts";
export interface CommunityReleaseUI {
  authorized(): boolean;
  policy(): string;
  consent(): boolean;
  onConsent(value: boolean): void;
  rating(): "general" | "adult" | null;
  onRating(value: "general" | "adult"): void;
  language(): string;
  issue(): string;
}
export interface CommunitySongComposerProps extends PostComposerProps {
  release: CommunityReleaseUI;
}
interface Props {
  controller: PostComposerController;
  runtime?: SongFlowRuntime;
  recipients?: unknown;
  release: CommunityReleaseUI;
}
// StepCard and ReviewRow composition/classes copied from the owned 289 Song
// rights/review source. Current backend accepts policy consent, not splits.
function StepCard(props: Props & { children: JSX.Element }) {
  return (
    <CardContent
      class={cn(
        "space-y-6 p-8",
        props.controller.isMobile() && "px-0 pb-4 pt-1",
      )}
    >
      {props.children}
    </CardContent>
  );
}
function ReviewRow(props: {
  label: string;
  value: JSX.Element;
  onChange?: () => void;
}) {
  return (
    <div class="flex items-start justify-between gap-3 border-b border-border-soft py-3 last:border-b-0">
      <div class="min-w-0">
        <Type as="p" variant="caption" class="text-muted-foreground">
          {props.label}
        </Type>
        <div class="mt-0.5 min-w-0 text-base text-foreground">
          {props.value}
        </div>
      </div>
      <Show when={props.onChange}>
        <Button onClick={props.onChange} size="sm" variant="ghost">
          Change
        </Button>
      </Show>
    </div>
  );
}
export function SongRightsStep(props: Props) {
  return (
    <StepCard {...props}>
      <fieldset
        class="space-y-8"
        disabled={props.runtime?.retained || props.runtime?.locked}
      >
        <Type as="p">{props.release.policy()}</Type>
        <Checkbox
          checked={props.release.consent()}
          onChange={props.release.onConsent}
        >
          <CheckboxLabel>
            I have the rights needed to publish this recording and accept the
            community release policy.
          </CheckboxLabel>
        </Checkbox>
        <Show when={props.release.policy() === OWNER_RELEASE_POLICY}>
          <RadioGroup
            aria-label="Declared release rating"
            value={props.release.rating() ?? ""}
            onChange={(value) => {
              if (value === "general" || value === "adult")
                props.release.onRating(value);
            }}
          >
            <RadioGroupItem value="general">General</RadioGroupItem>
            <RadioGroupItem value="adult">18+</RadioGroupItem>
          </RadioGroup>
        </Show>
      </fieldset>
      <FormNote>
        Collaborator credits, royalty splits and remix licensing are unavailable
        in this release protocol.
      </FormNote>
      <Show when={props.release.issue()}>
        {(message) => <FormNote tone="warning">{message()}</FormNote>}
      </Show>
    </StepCard>
  );
}
export function SongReviewStep(props: Props & { steps: ComposerSteps }) {
  const change = () =>
    props.runtime?.locked ? undefined : () => props.steps.set("song");
  return (
    <StepCard {...props}>
      <div class="rounded-[var(--radius-lg)] px-1">
        <ReviewRow
          label={props.controller.copy.review.song}
          value={props.controller.song.state.title ?? ""}
          onChange={change()}
        />
        <ReviewRow
          label={props.controller.copy.review.lyrics}
          value={
            props.controller.fields.lyricsValue.trim() ||
            props.controller.copy.review.noLyrics
          }
          onChange={change()}
        />
        <ReviewRow
          label="Release policy"
          value={props.release.policy()}
          onChange={() => props.steps.set("rights")}
        />
        <ReviewRow label="Language" value={props.release.language()} />
        <Show when={props.release.rating()}>
          <ReviewRow
            label="Declared rating"
            value={props.release.rating() === "adult" ? "18+" : "General"}
          />
        </Show>
      </div>
      <FormNote>
        Recordings and lyrics pass the community admission policy before
        publication. Nothing is published until the canonical job and feed
        confirm it.
      </FormNote>
    </StepCard>
  );
}
