// A sender can ask for a Retry-After of minutes or hours. Waiting that long
// inside a sync tick would hold the sync lock and run towards the 15-minute
// wall-time limit, so the wait is cut to this. A call that still fails is
// handled like any other failure.
const MAX_RETRY_DELAY_MS = 5000;

// Retry-After may also be an HTTP date, which is treated as absent.
export function retryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const backoffMs = 2 ** attempt * 250;
  if (!retryAfterHeader) return backoffMs;
  const seconds = Number(retryAfterHeader);
  if (!Number.isFinite(seconds) || seconds < 0) return backoffMs;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}
