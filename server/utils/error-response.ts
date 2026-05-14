/**
 * error-response.ts — safe error formatting for HTTP responses.
 *
 * Many routes use `err instanceof Error ? err.message : String(err)` directly
 * in the response body. Error messages can leak file paths, library
 * internals, stack frames, env values, etc. This helper hides the raw
 * message in production but keeps it in development for debugging.
 *
 * Set NODE_ENV=production in deployment to turn on the redaction.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

/** Convert any thrown value into a string safe to send to a client. */
export function safeErrorMessage(err: unknown, fallback = 'Internal error'): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Always strip out absolute filesystem paths regardless of env — those leak
  // host info even in dev when sharing screenshots / logs.
  const scrubbed = raw
    .replace(/[A-Z]:[\\/][^\s'":,;]+/gi, '<path>')  // C:\... / D:/...
    .replace(/\/(home|root|var|etc|tmp|opt)\/[^\s'":,;]*/g, '<path>')
    .slice(0, 300);

  if (IS_PROD) {
    // In prod, do not return raw exception text — log it server-side and
    // return a generic message. The fallback is what the user sees.
    return fallback;
  }
  return scrubbed;
}
