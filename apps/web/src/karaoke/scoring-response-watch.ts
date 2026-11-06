/** Stop waiting indefinitely for expected server feedback while media plays. */
export class ScoringResponseWatch {
  private since: number | null = null;
  private received = 0;

  reset() {
    this.since = null;
    this.received = 0;
  }

  expired(input: {
    playing: boolean;
    expected: number;
    received: number;
    now: number;
  }) {
    const progressed = input.received > this.received;
    this.received = input.received;
    if (!input.playing || input.expected <= input.received) {
      this.since = null;
      return false;
    }
    if (this.since === null || progressed) this.since = input.now;
    return input.now - this.since >= 10000;
  }
}
