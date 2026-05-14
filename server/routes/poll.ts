/**
 * Poll Routes
 *
 * POST /api/poll/start   — start a new poll
 * POST /api/poll/close   — close current poll early
 * POST /api/poll/reset   — clear poll state
 * GET  /api/poll/state   — current poll state
 * POST /api/poll/vote    — manually submit a vote (for testing)
 */

import { Router, type Request, type Response } from 'express';
import { pollManager } from '../services/poll-manager.js';

const router = Router();

/** POST /api/poll/start */
router.post('/start', (req: Request, res: Response) => {
  const { question, options, durationSecs } = req.body as {
    question?: string;
    options?: string[];
    durationSecs?: number;
  };

  if (!question?.trim()) {
    res.status(400).json({ ok: false, error: 'question required' });
    return;
  }
  if (!Array.isArray(options) || options.length < 2) {
    res.status(400).json({ ok: false, error: 'options array (min 2) required' });
    return;
  }

  const durationMs = typeof durationSecs === 'number' && durationSecs > 0
    ? durationSecs * 1000
    : undefined;

  const state = pollManager.start(question.trim(), options.map(o => String(o).trim()), durationMs);
  res.json({ ok: true, state, remainingSecs: pollManager.remainingSecs });
});

/** POST /api/poll/close */
router.post('/close', (_req: Request, res: Response) => {
  const state = pollManager.close();
  res.json({ ok: true, state });
});

/** POST /api/poll/reset */
router.post('/reset', (_req: Request, res: Response) => {
  pollManager.reset();
  res.json({ ok: true });
});

/** GET /api/poll/state */
router.get('/state', (_req: Request, res: Response) => {
  res.json({ ...pollManager.state, remainingSecs: pollManager.remainingSecs });
});

/** POST /api/poll/vote — manual vote injection (testing / admin) */
router.post('/vote', (req: Request, res: Response) => {
  const { user, vote } = req.body as { user?: string; vote?: string };
  if (!user?.trim() || !vote?.trim()) {
    res.status(400).json({ ok: false, error: 'user and vote required' });
    return;
  }
  const counted = pollManager.recordVote(user.trim(), vote.trim());
  res.json({ ok: counted, state: pollManager.state });
});

export default router;
