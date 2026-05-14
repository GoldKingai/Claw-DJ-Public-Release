/**
 * Shoutout Routes (Revenue — Phase 5.1)
 *
 * GET  /api/shoutouts/stream   — SSE stream of shoutout events (for display client)
 * POST /api/shoutouts/add      — add a shoutout to the queue
 * POST /api/shoutouts/ack      — acknowledge/skip current shoutout
 * POST /api/shoutouts/clear    — clear the queue
 * GET  /api/shoutouts/state    — current queue + history snapshot
 */

import { Router, type Request, type Response } from 'express';
import { shoutoutManager } from '../services/shoutout-manager.js';

const router = Router();

// ── SSE stream ────────────────────────────────────────────────────────────────

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  shoutoutManager.addClient(send);

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    shoutoutManager.removeClient(send);
  });
});

// ── Add shoutout ──────────────────────────────────────────────────────────────

/**
 * POST /api/shoutouts/add
 * Body: { name, message?, amount?, imageUrl?, displaySecs? }
 */
router.post('/add', (req: Request, res: Response) => {
  const { name, message, amount, imageUrl, displaySecs } = req.body as {
    name?: string;
    message?: string;
    amount?: string;
    imageUrl?: string;
    displaySecs?: number;
  };

  if (!name?.trim()) {
    res.status(400).json({ ok: false, error: 'name required' });
    return;
  }

  const shoutout = shoutoutManager.add({
    name: name.trim(),
    message: message?.trim(),
    amount: amount?.trim(),
    imageUrl: imageUrl?.trim(),
    displaySecs: typeof displaySecs === 'number' && displaySecs > 0 ? displaySecs : 10,
  });

  res.json({ ok: true, shoutout });
});

// ── Acknowledge ───────────────────────────────────────────────────────────────

router.post('/ack', (_req: Request, res: Response) => {
  shoutoutManager.acknowledge();
  res.json({ ok: true });
});

// ── Clear queue ───────────────────────────────────────────────────────────────

router.post('/clear', (_req: Request, res: Response) => {
  shoutoutManager.clearQueue();
  res.json({ ok: true });
});

// ── State snapshot ────────────────────────────────────────────────────────────

router.get('/state', (_req: Request, res: Response) => {
  res.json({
    current: shoutoutManager.current,
    isDisplaying: shoutoutManager.isDisplaying,
    queueLength: shoutoutManager.queue.length,
    queue: shoutoutManager.queue,
    history: shoutoutManager.history,
  });
});

export default router;
