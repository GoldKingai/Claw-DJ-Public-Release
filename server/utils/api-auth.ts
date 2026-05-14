/**
 * api-auth.ts — optional shared-secret auth for mutating endpoints.
 *
 * Off by default to preserve current behaviour (trusted LAN install).
 * Set API_TOKEN in .env to enable:
 *
 *   - Any POST/PUT/PATCH/DELETE request must carry:
 *       Authorization: Bearer <API_TOKEN>
 *     ...OR connect from localhost (127.0.0.1 / ::1).
 *   - GET requests pass through unchanged (read-only, lower risk).
 *   - Specific path prefixes can be exempted (OAuth callbacks, SSE
 *     streams the browser source connects to, etc.).
 *
 * If API_TOKEN is unset, the middleware is a no-op — no breaking change
 * to existing deployments. Owner can opt in by setting the env var and
 * restarting; clients on the LAN that need write access then need the
 * Bearer header.
 */

import type { Request, Response, NextFunction } from 'express';

const TOKEN = process.env.API_TOKEN || '';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Path prefixes that bypass the token check even when API_TOKEN is set.
 * Reasons:
 *   - /api/broadcast/auth/callback : called by Google's OAuth redirect,
 *       we have no way to attach a Bearer header to that redirect.
 *       The OAuth `state` parameter provides CSRF protection instead.
 *   - /api/dj-engine/controller/* : background liveness pings from the
 *       browser-side controller (no header injection point).
 *       These are no-ops on the server anyway.
 */
const EXEMPT_PATH_PREFIXES = [
  '/api/broadcast/auth/callback',
  '/api/dj-engine/controller/heartbeat',
  '/api/dj-engine/controller/offline',
];

function isLocalRequest(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  // Off by default — preserves all existing behaviour for trusted-LAN installs.
  if (!TOKEN) {
    next();
    return;
  }
  // GET / HEAD / OPTIONS are read-only or preflight — let through.
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  // Localhost always allowed (LLM Gateway + the dashboard on the same host).
  if (isLocalRequest(req)) {
    next();
    return;
  }
  // Exempt OAuth + heartbeat paths.
  for (const prefix of EXEMPT_PATH_PREFIXES) {
    if (req.path.startsWith(prefix) || req.originalUrl.startsWith(prefix)) {
      next();
      return;
    }
  }

  const header = req.headers.authorization || '';
  const expected = `Bearer ${TOKEN}`;
  // Constant-time-ish comparison: same length first, then byte compare.
  // The token is short and not derived from user input, so a plain === is
  // acceptable, but lengths-must-match prevents trivial probing.
  if (header.length === expected.length && header === expected) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized: missing or invalid API token' });
}
