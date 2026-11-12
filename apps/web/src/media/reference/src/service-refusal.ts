/** Explicit service-port refusal; no generated centralized client or session. */
export class ServiceRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<{ reason_code?: string }>;
  readonly retryAfterSeconds?: number;
  constructor(
    status: number,
    code: string,
    retryable: boolean,
    details?: Readonly<{ reason_code?: string }>,
    retryAfterSeconds?: number,
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
