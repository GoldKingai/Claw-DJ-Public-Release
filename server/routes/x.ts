/**
 * routes/x.ts
 *
 * POST /api/x/post        — post a specific tweet (admin/manual)
 * POST /api/x/flow-post   — have Flow compose + post autonomously
 * GET  /api/x/status      — confirm keys are configured
 */

import { Router, Request, Response } from 'express';
import { postTweet, flowPost } from '../services/x-poster.js';
import { scheduleXAnnouncement, postFlowTweet } from '../services/watchdog.js';
import { rateLimit } from '../utils/rate-limit.js';

const router = Router();

// X/Twitter free tier allows ~17 posts/day. 5/hour per IP is generous and
// prevents an attacker from burning the quota or getting the account
// suspended for spam-like traffic. The service has a 5-min in-process
// anti-spam guard too; this protects against multi-process / distributed
// floods.
const xPostLimit = rateLimit({ keyPrefix: 'x.post', max: 5, windowMs: 60 * 60_000 });

router.get('/status', (_req: Request, res: Response) => {
  const configured = !!(
    process.env.X_CONSUMER_KEY &&
    process.env.X_ACCESS_TOKEN
  );
  res.json({ configured, handle: process.env.X_HANDLE ?? 'unknown' });
});

router.post('/post', xPostLimit, async (req: Request, res: Response) => {
  const { text, force } = req.body as { text?: string; force?: boolean };
  if (!text?.trim()) {
    res.status(400).json({ ok: false, error: 'text required' });
    return;
  }
  const result = await postTweet(text.trim(), force);
  res.json(result);
});

router.post('/flow-post', xPostLimit, async (req: Request, res: Response) => {
  const { prompt } = req.body as { prompt?: string };
  if (!prompt?.trim()) {
    res.status(400).json({ ok: false, error: 'prompt required' });
    return;
  }
  const result = await flowPost(prompt.trim());
  res.json(result);
});

router.post('/schedule', (req, res) => {
  const { streamStartMs } = req.body as { streamStartMs?: number };
  if (!streamStartMs || typeof streamStartMs !== 'number') {
    res.status(400).json({ ok: false, error: 'streamStartMs (unix ms) required' });
    return;
  }
  scheduleXAnnouncement(streamStartMs);
  const dt = new Date(streamStartMs).toISOString();
  res.json({ ok: true, scheduled: dt });
});

router.post('/presence-post', xPostLimit, async (req, res) => {
  const { prompt } = req.body as { prompt?: string };
  const p = prompt?.trim() || 
    'x-scheduler: post something spontaneous as Flow the AI DJ — music, mood, a thought, hype for your next stream. In character. Max 280 chars.';
  await postFlowTweet(p);
  res.json({ ok: true });
});

export default router;
