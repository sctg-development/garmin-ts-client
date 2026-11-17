/** Stable failure classes, the same names `gc` reports, so callers can branch on them. */
export type GarminErrorCode = "auth" | "rate_limited" | "connection" | "not_found" | "error";

export class GarminError extends Error {
  readonly code: GarminErrorCode;
  readonly status: number | null;
  constructor(code: GarminErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GarminError";
    this.code = code;
    this.status = status;
  }
}

export class GarminAuthError extends GarminError {
  constructor(message: string, status: number | null = null) {
    super("auth", message, status);
    this.name = "GarminAuthError";
  }
}

export class GarminRateLimitError extends GarminError {
  constructor(message: string) {
    super("rate_limited", message, 429);
    this.name = "GarminRateLimitError";
  }
}
