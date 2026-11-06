/** Request-local diagnostics. Names and counts only; never URLs, arguments,
 * wallet addresses, signatures or provider response contents. */
export class RequestTiming {
  private readonly started = performance.now();
  private readonly entries = new Map<string, { ms: number; count: number }>();

  record(name: string, ms: number) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) return;
    const entry = this.entries.get(name) ?? { ms: 0, count: 0 };
    entry.ms += ms;
    entry.count++;
    this.entries.set(name, entry);
  }

  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  header() {
    return [
      `total;dur=${(performance.now() - this.started).toFixed(1)}`,
      ...Array.from(
        this.entries,
        ([name, { ms, count }]) =>
          `${name};dur=${ms.toFixed(1)};desc="${count} calls"`,
      ),
    ].join(", ");
  }
}
