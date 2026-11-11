/** Explicit service-port refusal; no generated centralized client or session. */
export class ServiceRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: Readonly<{ reason_code?: string }>,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
