/** Ordinary requests remain answerable independently of a short CLI/MCP poll. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10_800;
export const MAX_REQUEST_TIMEOUT_SECONDS = 10_800;
export const MAX_ACTIVITY_TIMEOUT_SECONDS = 3_600;

export function requestTimeoutSeconds(value: number | undefined, fallback = DEFAULT_REQUEST_TIMEOUT_SECONDS, maximum = MAX_REQUEST_TIMEOUT_SECONDS): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > maximum) {
    throw new Error(`timeoutSeconds must be an integer between 1 and ${maximum}`);
  }
  return timeout;
}

/** Wait budget for one ask call, not the signed request lifetime. */
export const MAX_REPLY_WAIT_SECONDS = 55;
