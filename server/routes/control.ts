/**
 * Control routes — operational authority via the local engine.
 * Queue mutations now operate on the local engine (the real authority),
 * not the legacy nowplaying browser-relay state.
 */

import { Router, type Request, type Response } from 'express';
import { djLocalEngine } from '../services/dj-local-engine.js';
import { getNowPlayingState } from './nowplaying.js';
import { opsMemory } from '../services/ops-memory.js';

const router = Router();

router.get('/queue', (_req: Request, res: Response) => {
  const state = djLocalEngine.snapshot();
  res.json({
    currentTrack: state.currentTrackTitle
      ? { id: state.currentTrackId, title: state.currentTrackTitle, artist: state.currentTrackArtist }
      : null,
    isPlaying: state.mode === 'playing',
    queue: state.queue,
    queueRevision: state.queueRevision,
    updatedAt: state.updatedAt,
  });
});

router.post('/queue/clear', (_req: Request, res: Response) => {
  const state = djLocalEngine.clearQueue();
  res.json({ ok: true, queue: state.queue });
});

router.post('/queue/remove', (req: Request, res: Response) => {
  const { queueItemId, index } = req.body as { queueItemId?: string; index?: number };
  if (queueItemId) {
    res.json({ ok: true, state: djLocalEngine.removeQueueById(queueItemId) });
    return;
  }
  if (typeof index === 'number' && index >= 0) {
    res.json({ ok: true, state: djLocalEngine.removeQueueIndex(index) });
    return;
  }
  res.status(400).json({ error: 'queueItemId or valid index required' });
});

router.post('/queue/move', (req: Request, res: Response) => {
  const { from, to } = req.body as { from?: number; to?: number };
  if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to < 0) {
    res.status(400).json({ error: 'valid from/to indexes required' });
    return;
  }
  const state = djLocalEngine.moveQueueItem(from, to);
  res.json({ ok: true, queue: state.queue });
});

router.get('/memory', (_req: Request, res: Response) => {
  res.json(opsMemory.snapshot());
});

export default router;
