// Error type for backend services whose failures map to a specific HTTP
// status when they surface through an API route. `code` lets routes branch on
// a specific failure (e.g. fall back to the local prompt improver) without
// matching on human-readable message text.
export class BackendHttpError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, options: { statusCode: number; code?: string }) {
    super(message);
    this.name = "BackendHttpError";
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}

export function httpStatusFromError(error: unknown, fallbackStatus: number) {
  return error instanceof BackendHttpError ? error.statusCode : fallbackStatus;
}

export function httpErrorCode(error: unknown) {
  return error instanceof BackendHttpError ? error.code : undefined;
}
