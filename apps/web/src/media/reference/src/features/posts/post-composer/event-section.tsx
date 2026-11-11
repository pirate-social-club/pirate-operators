// Event (date/place) section of the write step, ported from the React
// post-composer-event-section.tsx. The timezone picker uses the DS Combobox.

import { createSignal, For, Show } from "solid-js";

import {
  Checkbox,
  CheckboxLabel,
  Combobox,
  FormNote,
  IconCalendarBlank,
  IconMapPin,
  IconVideoCamera,
  Input,
  Type,
} from "../../../design-system.ts";
import { cn } from "../../../design-system.ts";
import { FieldLabel } from "./fields.tsx";
import type { ComposerEventPlace, ComposerEventState } from "./types.ts";

interface TimeZoneOption {
  cityLabel: string;
  id: string;
  label: string;
  offsetLabel: string;
  searchLabel: string;
  value: string;
}

const fallbackTimeZones = [
  "Asia/Tbilisi",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
] as const;

function localDateValue(value: string | undefined): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2})?$/.exec(
    value?.trim() ?? "",
  );
  return match?.[1] ?? "";
}

function localTimeValue(value: string | undefined): string {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})$/.exec(value?.trim() ?? "");
  return match?.[1] ?? "";
}

function composeLocalDateTime(date: string, time: string): string | undefined {
  const trimmedDate = date.trim();
  if (!trimmedDate) return undefined;
  const trimmedTime = time.trim();
  return trimmedTime ? `${trimmedDate}T${trimmedTime}` : trimmedDate;
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function supportedTimeZones(): string[] {
  // SAFETY: this feature is optional in the Intl runtime; the fallback below
  // is used when the host does not implement it.
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;

  if (typeof supportedValuesOf === "function") {
    return supportedValuesOf("timeZone");
  }
  return [...fallbackTimeZones];
}

function isValidTimeZone(value: string | undefined): boolean {
  const timezone = value?.trim();
  if (!timezone) return false;

  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone }).format(
      new Date(),
    );
    return true;
  } catch {
    return false;
  }
}

function timeZoneOffsetLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      timeZone: timezone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function timeZoneCityLabel(timezone: string): string {
  if (timezone === "UTC") return "UTC";
  const city = timezone.split("/").pop() ?? timezone;
  return city.replace(/_/gu, " ");
}

function makeTimeZoneOption(timezone: string): TimeZoneOption {
  const cityLabel = timeZoneCityLabel(timezone);
  const offsetLabel = timeZoneOffsetLabel(timezone);
  const label = offsetLabel ? `${cityLabel} · ${offsetLabel}` : cityLabel;

  return {
    cityLabel,
    id: timezone,
    label,
    offsetLabel,
    searchLabel: `${label} ${timezone}`,
    value: timezone,
  };
}

function timeZoneOptions(): TimeZoneOption[] {
  return supportedTimeZones().map(makeTimeZoneOption);
}

function TimeZonePicker(props: {
  id?: string;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const options = timeZoneOptions();

  return (
    <Combobox<TimeZoneOption>
      aria-label="Search time zones"
      onChange={(value) => {
        if (value) {
          props.onChange(value);
        }
      }}
      optionLabel={(option) => option.searchLabel}
      options={options}
      optionValue={(option) => option.value}
      placeholder="Search time zones"
      value={props.value ?? defaultTimeZone()}
    />
  );
}

export function PostComposerEventSection(props: {
  class?: string;
  event: ComposerEventState;
  onChange: (value: ComposerEventState) => void;
  onSearchPlaces?: (query: string) => Promise<ComposerEventPlace[]>;
}) {
  const enabled = () => props.event.enabled === true;
  const isOnline = () => props.event.isOnline === true;
  const locationQuery = () => props.event.locationName ?? "";
  const [suggestions, setSuggestions] = createSignal<ComposerEventPlace[]>([]);
  const [searchLoading, setSearchLoading] = createSignal(false);
  let searchRequestId = 0;
  const timezoneInvalid = () =>
    Boolean(
      enabled() &&
        props.event.timezone?.trim() &&
        !isValidTimeZone(props.event.timezone),
    );

  // Place search, debounced like the React version. The timer only runs in
  // response to user typing; stories pass an in-memory onSearchPlaces.
  const scheduleSearch = (query: string) => {
    searchRequestId += 1;
    const requestId = searchRequestId;
    const search = props.onSearchPlaces;

    if (
      !enabled() ||
      isOnline() ||
      query.length < 2 ||
      props.event.place?.label === query ||
      !search
    ) {
      setSuggestions([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const timeoutId = globalThis.setTimeout(() => {
      void search(query)
        .then((places) => {
          if (searchRequestId !== requestId) return;
          setSuggestions(places);
        })
        .catch(() => {
          if (searchRequestId !== requestId) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (searchRequestId !== requestId) return;
          setSearchLoading(false);
        });
    }, 300);
    return () => globalThis.clearTimeout(timeoutId);
  };

  let lastSearchedQuery: string | null = null;
  const maybeSearch = () => {
    const query = locationQuery().trim();
    if (query === lastSearchedQuery) return;
    lastSearchedQuery = query;
    scheduleSearch(query);
  };

  function update(patch: Partial<ComposerEventState>) {
    props.onChange({ ...props.event, ...patch });
  }

  function updateDateTime(
    field: "startsAt" | "endsAt",
    patch: { date?: string; time?: string },
  ) {
    const current = props.event[field];
    const date = patch.date ?? localDateValue(current);
    const time = patch.time ?? localTimeValue(current);
    update({ [field]: composeLocalDateTime(date, time) });
  }

  function selectPlace(place: ComposerEventPlace) {
    props.onChange({
      ...props.event,
      address: place.address,
      locationName: place.label,
      place,
    });
  }

  return (
    <section
      class={cn("space-y-4 border-t border-border-soft pt-4", props.class)}
    >
      <div class="flex items-center gap-3">
        <Checkbox
          aria-label="Add date and place"
          checked={enabled()}
          id="post-event-enabled"
          onChange={(checked) =>
            props.onChange({
              ...props.event,
              enabled: checked === true,
              timezone: props.event.timezone ?? defaultTimeZone(),
            })
          }
        >
          <CheckboxLabel class="font-semibold">
            Add date and place
          </CheckboxLabel>
        </Checkbox>
      </div>

      <Show when={enabled()}>
        <div class="space-y-4">
          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <FieldLabel
                htmlFor="post-event-start-date"
                label="Start date"
                required
              />
              <Input
                class="h-10"
                id="post-event-start-date"
                onChange={(inputEvent) =>
                  updateDateTime("startsAt", {
                    date: inputEvent.currentTarget.value,
                  })
                }
                type="date"
                value={localDateValue(props.event.startsAt)}
              />
            </div>
            <div>
              <FieldLabel htmlFor="post-event-start-time" label="Start time" />
              <Input
                class="h-10"
                disabled={!localDateValue(props.event.startsAt)}
                id="post-event-start-time"
                onChange={(inputEvent) =>
                  updateDateTime("startsAt", {
                    time: inputEvent.currentTarget.value,
                  })
                }
                type="time"
                value={localTimeValue(props.event.startsAt)}
              />
            </div>
            <div>
              <FieldLabel htmlFor="post-event-end-date" label="End date" />
              <Input
                class="h-10"
                id="post-event-end-date"
                onChange={(inputEvent) =>
                  updateDateTime("endsAt", {
                    date: inputEvent.currentTarget.value,
                  })
                }
                type="date"
                value={localDateValue(props.event.endsAt)}
              />
            </div>
            <div>
              <FieldLabel htmlFor="post-event-end-time" label="End time" />
              <Input
                class="h-10"
                disabled={!localDateValue(props.event.endsAt)}
                id="post-event-end-time"
                onChange={(inputEvent) =>
                  updateDateTime("endsAt", {
                    time: inputEvent.currentTarget.value,
                  })
                }
                type="time"
                value={localTimeValue(props.event.endsAt)}
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="post-event-timezone" label="Timezone" />
            <TimeZonePicker
              id="post-event-timezone"
              onChange={(timezone) => update({ timezone })}
              value={props.event.timezone ?? defaultTimeZone()}
            />
            <Show
              when={timezoneInvalid()}
              fallback={
                <FormNote class="mt-1">
                  Uses your browser timezone by default.
                </FormNote>
              }
            >
              <FormNote class="mt-1" tone="destructive">
                Choose a valid event timezone.
              </FormNote>
            </Show>
          </div>

          <div class="flex items-center gap-3">
            <Checkbox
              aria-label="Online event"
              checked={isOnline()}
              id="post-event-online"
              onChange={(checked) =>
                props.onChange({
                  ...props.event,
                  address: checked === true ? undefined : props.event.address,
                  isOnline: checked === true,
                  locationName:
                    checked === true ? undefined : props.event.locationName,
                  place: checked === true ? undefined : props.event.place,
                })
              }
            >
              <CheckboxLabel class="flex items-center gap-2">
                <IconVideoCamera class="size-4 text-muted-foreground" />
                Online event
              </CheckboxLabel>
            </Checkbox>
          </div>

          <Show when={!isOnline()}>
            <div class="space-y-3">
              <div>
                <FieldLabel
                  htmlFor="post-event-location"
                  label="Venue or place"
                />
                <Input
                  class={cn(
                    "h-10 transition-opacity",
                    searchLoading() && "opacity-70",
                  )}
                  id="post-event-location"
                  onChange={(inputEvent) => {
                    update({
                      locationName: inputEvent.currentTarget.value,
                      place: undefined,
                    });
                    maybeSearch();
                  }}
                  placeholder="Search a venue or enter a place"
                  value={locationQuery()}
                />
              </div>

              <Show when={suggestions().length > 0}>
                <div
                  class={cn(
                    "space-y-2 transition-opacity",
                    searchLoading() && "opacity-70",
                  )}
                >
                  <For each={suggestions()}>
                    {(place) => (
                      <button
                        class="flex w-full items-start gap-2 rounded-md border border-border-soft px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => selectPlace(place)}
                        type="button"
                      >
                        <IconMapPin class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span class="min-w-0">
                          <span class="block truncate font-semibold text-foreground">
                            {place.label}
                          </span>
                          <Show when={place.address}>
                            <Type
                              as="span"
                              class="block truncate"
                              variant="caption"
                            >
                              {place.address}
                            </Type>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <div>
                <FieldLabel htmlFor="post-event-address" label="Address" />
                <Input
                  class="h-10"
                  id="post-event-address"
                  onChange={(inputEvent) =>
                    update({
                      address: inputEvent.currentTarget.value,
                      place: undefined,
                    })
                  }
                  placeholder="Street address or neighborhood"
                  value={props.event.address ?? ""}
                />
              </div>
            </div>
          </Show>

          <div>
            <FieldLabel htmlFor="post-event-url" label="Event URL" />
            <div class="relative">
              <IconCalendarBlank class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                class="h-10 pl-9"
                id="post-event-url"
                inputmode="url"
                onChange={(inputEvent) =>
                  update({ eventUrl: inputEvent.currentTarget.value })
                }
                placeholder="https://..."
                type="url"
                value={props.event.eventUrl ?? ""}
              />
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
