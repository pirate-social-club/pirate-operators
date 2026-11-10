import { createSignal, For, Show } from "solid-js";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import { dollars } from "./reward-wallet.ts";
import type { RewardOperatorView, RewardsData } from "./rewards-data.ts";
import { closeAvailability } from "../wallet/close-readiness.ts";
const field =
  "w-full rounded border border-border-soft bg-transparent p-2 text-foreground";
const localTime = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
export function RewardOfferPanel(props: {
  view: RewardOperatorView;
  data: RewardsData;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
}) {
  const [kind, setKind] = createSignal(
      props.view.rehearsal ? "rehearsal" : "live",
    ),
    [song, setSong] = createSignal(""),
    [drawing, setDrawing] = createSignal(""),
    [purchase, setPurchase] = createSignal(""),
    [tickets, setTickets] = createSignal("");
  const [opens, setOpens] = createSignal(localTime(Date.now() + 120000)),
    [cutoff, setCutoff] = createSignal(
      localTime(Date.now() + (props.view.rehearsal ? 86400000 : 3600000)),
    ),
    [claimHashes, setClaimHashes] = createSignal<Record<string, string>>({});
  const selectedSong = () => song() || props.view.songs[0]?.songKey || "";
  const rehearsal = () =>
    kind() === "rehearsal" ? props.view.rehearsal : null;
  const alreadyAttached = () =>
    !!rehearsal() &&
    props.view.offers.some((o) => o.offerId === rehearsal()!.offerId);
  return (
    <div class="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            {rehearsal()
              ? "Create rehearsal offer"
              : "Attach purchased tickets"}
          </Type>
        </CardHeader>
        <CardContent>
          <form
            class="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void props.run(async () => {
                const terms = rehearsal();
                await props.data.operation("/offers", {
                  offerId: terms?.offerId ?? crypto.randomUUID(),
                  drawingId: terms?.drawingId ?? drawing(),
                  songKey: selectedSong(),
                  purchaseHash: terms?.purchaseHash ?? purchase(),
                  ticketIds:
                    terms?.ticketIds ??
                    tickets()
                      .split(",")
                      .map((x) => x.trim()),
                  opensAt: new Date(opens()).getTime(),
                  cutoffAt: new Date(cutoff()).getTime(),
                });
              });
            }}
          >
            <Show when={props.view.rehearsal}>
              <label class="flex flex-col gap-2">
                Drawing source
                <select
                  class={field}
                  value={kind()}
                  onChange={(e) => setKind(e.currentTarget.value)}
                >
                  <option value="rehearsal">Configured rehearsal</option>
                  <option value="live">Megapot tickets</option>
                </select>
              </label>
            </Show>
            <Show when={rehearsal()}>
              {(terms) => (
                <Type as="p">
                  Simulated ticket and prize evidence:{" "}
                  {dollars(terms().prizeUsdcAtomic, 6)} total. Payments use
                  prefunded testnet dollars. This one offer fixes its song and
                  window when attached; allow time to complete the real lesson
                  before closing.
                </Type>
              )}
            </Show>
            <label class="flex flex-col gap-2">
              Song
              <select
                class={field}
                value={selectedSong()}
                onChange={(e) => setSong(e.currentTarget.value)}
              >
                <For each={props.view.songs}>
                  {(s) => <option value={s.songKey}>{s.title}</option>}
                </For>
              </select>
            </label>
            <Show when={!rehearsal()}>
              <label class="flex flex-col gap-2">
                Drawing number
                <input
                  required
                  class={field}
                  value={drawing()}
                  onInput={(e) => setDrawing(e.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-2">
                Purchase transaction
                <input
                  required
                  class={field}
                  value={purchase()}
                  onInput={(e) => setPurchase(e.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-2">
                Ticket IDs, separated by commas
                <input
                  required
                  class={field}
                  value={tickets()}
                  onInput={(e) => setTickets(e.currentTarget.value)}
                />
              </label>
            </Show>
            <label class="flex flex-col gap-2">
              Entries open
              <input
                required
                class={field}
                type="datetime-local"
                value={opens()}
                onInput={(e) => setOpens(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-2">
              Entries close
              <input
                required
                class={field}
                type="datetime-local"
                value={cutoff()}
                onInput={(e) => setCutoff(e.currentTarget.value)}
              />
            </label>
            <Button
              disabled={props.busy || !selectedSong() || alreadyAttached()}
              type="submit"
            >
              {rehearsal()
                ? alreadyAttached()
                  ? "Rehearsal already attached"
                  : "Attach rehearsal offer"
                : "Attach tickets"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            Drawing records
          </Type>
        </CardHeader>
        <CardContent class="flex flex-col gap-5">
          <For each={props.view.offers}>
            {(offer) => (
              <div class="flex flex-col gap-2">
                <Type as="p" class="break-all">
                  {offer.evidenceMode === "simulated"
                    ? "Rehearsal offer"
                    : `Drawing ${offer.drawingId}`}{" "}
                  · {offer.state.replaceAll("_", " ")}
                </Type>
                <Type as="p" variant="caption">
                  {offer.offerId}
                </Type>
                <Show when={offer.state === "open"}>
                  <Button
                    variant="outline"
                    disabled={
                      props.busy ||
                      !closeAvailability(offer, props.view.closeReadiness).ready
                    }
                    onClick={() =>
                      void props.run(async () => {
                        await props.data.operation(
                          `/offers/${offer.offerId}/close`,
                          {},
                        );
                      })
                    }
                  >
                    Close entries
                  </Button>
                  <Type as="p" variant="caption" role="status">
                    {closeAvailability(offer, props.view.closeReadiness).reason}
                  </Type>
                </Show>
                <Show when={offer.state === "closed"}>
                  <Show when={offer.evidenceMode !== "simulated"}>
                    <label class="flex flex-col gap-2">
                      Collection transaction, required for a win
                      <input
                        class={field}
                        value={claimHashes()[offer.offerId] ?? ""}
                        onInput={(e) =>
                          setClaimHashes({
                            ...claimHashes(),
                            [offer.offerId]: e.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  </Show>
                  <Button
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      void props.run(async () => {
                        await props.data.operation(
                          `/offers/${offer.offerId}/settle`,
                          offer.evidenceMode === "simulated"
                            ? {}
                            : {
                                ...(claimHashes()[offer.offerId]
                                  ? { claimHash: claimHashes()[offer.offerId] }
                                  : {}),
                              },
                        );
                      })
                    }
                  >
                    {offer.evidenceMode === "simulated"
                      ? "Credit simulated prize"
                      : "Check settled winnings"}
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </CardContent>
      </Card>
    </div>
  );
}
