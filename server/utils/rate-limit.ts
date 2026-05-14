/**
 * rate-limit.ts — minimal in-memory token-bucket per route key.
 *
 * Zero deps. Per-IP buckets. Old buckets are pruned lazily so memory
 * doesn't grow unbounded under sustained traffic.
 *
 * Usage:
 *   import { rateLimit } from '../utils/rate-limit.js';
 *   router.post('/expensive', rateLimit({ keyPrefix: 'tts', max: 10, windowMs: 60_000 }), handler);
 *
 * On exceed: returns 429 with a Retry-After header.
 */

import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

interface Options {
  /** Logical name for this limit (used for per-route bucket isolation). */
  keyPrefix: string;
  /** Maximum requests per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

// Global Map: "<keyPrefix>:<ip>" → bucket. Across all rateLimit() instances.
const buckets = new Map<string, Bucket>();

// Periodically prune expired buckets so memory doesn't grow unbounded.
// (Lazy on every call would scan the whole Map; a 5-min sweep is cheaper.)
let _sweepTimer: ReturnType<typeof setInterval> | null = null;
function _ensureSweep(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt < now) buckets.delete(k);
    }
  }, 5 * 60_000);
  // Allow process to exit even if this timer is alive (don't block shutdown).
  (_sweepTimer as unknown as { unref?: () => void }).unref?.();
}

export function rateLimit(opts: Options) {
  _ensureSweep();
  return function (req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    if (bucket.count >= opts.max) {
      const retryAfterSecs = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSecs));
      res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds: retryAfterSecs,
      });
      return;
    }

    bucket.count++;
    next();
  };
}
