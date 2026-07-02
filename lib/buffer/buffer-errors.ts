export class BufferApiError extends Error {
  readonly code = "BUFFER_API_ERROR" as const;
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "BufferApiError";
  }
}

export class BufferNoConnectionError extends Error {
  readonly code = "BUFFER_NO_CONNECTION" as const;
  constructor() {
    super("No Buffer connection found for this company.");
    this.name = "BufferNoConnectionError";
  }
}

export class BufferTokenExpiredError extends Error {
  readonly code = "BUFFER_TOKEN_EXPIRED" as const;
  constructor() {
    super("Buffer access token is expired or invalid. Please reconnect Buffer.");
    this.name = "BufferTokenExpiredError";
  }
}

export class BufferInvalidProfileError extends Error {
  readonly code = "BUFFER_INVALID_PROFILE" as const;
  constructor() {
    super("The selected Buffer profile is not accessible. Please select a different profile.");
    this.name = "BufferInvalidProfileError";
  }
}
