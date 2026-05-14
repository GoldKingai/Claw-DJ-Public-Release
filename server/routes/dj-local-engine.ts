import { Router, type Request, type Response } from 'express';
import { djLocalEngine } from '../services/dj-local-engine.js';

const router = Router();

// ── Read endpoints (canonical, keep these) ────────────────────────────────────

router.get('/state', async (_req: Request, res: Response) => {
  res.json({
    ...(await djLocalEngine.refreshWorkerState()),
    role: 'primary-local-transport',
  });
});

router.post('/crossfade', (req: Request, res: Response) => {
  const { seconds } = req.body as { seconds?: number };
  if (typeof seconds !== 'number') {
    res.status(400).json({ error: 'seconds must be a number' });
    return;
  }
  res.json({ ok: true, state: djLocalEngine.setCrossfadeSeconds(seconds) });
});

// ── Deprecated write routes — 410 Gone ───────────────────────────────────────
// All playback control now goes through POST /api/playback/commands

const DEPRECATED = (endpoint: string, replacement: string) =>
  (_req: Request, res: Response) => {
    res.status(410).json({
      error: 'deprecated',
      message: `${endpoint} is deprecated. Use POST /api/playback/commands instead.`,
      replacement: `POST /api/playback/commands { "type": "${replacement}", "payload": { ... } }`,
    });
  };

router.post('/play/:trackId',    DEPRECATED('/api/dj-local-engine/play/:trackId', 'play-track-now'));
router.post('/pause',            DEPRECATED('/api/dj-local-engine/pause', 'pause'));
router.post('/resume',           DEPRECATED('/api/dj-local-engine/resume', 'resume'));
router.post('/stop',             DEPRECATED('/api/dj-local-engine/stop', 'stop'));
router.post('/skip',             DEPRECATED('/api/dj-local-engine/skip', 'skip'));
router.post('/seek',             DEPRECATED('/api/dj-local-engine/seek', 'seek'));
router.post('/volume',           DEPRECATED('/api/dj-local-engine/volume', 'set-volume'));
router.post('/queue/enqueue/:trackId', DEPRECATED('/api/dj-local-engine/queue/enqueue', 'enqueue'));
router.post('/queue/remove',     DEPRECATED('/api/dj-local-engine/queue/remove', 'remove-queue-item'));
router.post('/queue/clear',      DEPRECATED('/api/dj-local-engine/queue/clear', 'clear-queue'));

export default router;
