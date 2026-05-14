import { Router, type Request, type Response } from 'express';
import { djLocalEngine } from '../services/dj-local-engine.js';

const router = Router();

router.get('/state', async (_req: Request, res: Response) => {
  const state = await djLocalEngine.refreshWorkerState();
  res.json({
    ...state,
    role: 'local-engine',
    note: 'Deprecated route — use GET /api/playback/state for canonical state.',
  });
});

router.post('/controller/heartbeat', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post('/controller/offline', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post('/sync', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'deprecated',
    message: 'Browser sync is no longer accepted. Local engine owns playback state.',
    replacement: 'GET /api/playback/state',
  });
});

router.post('/ack', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'deprecated', message: 'Browser ack is no longer used. Local engine owns playback state.', replacement: 'GET /api/playback/state' });
});

// DEPRECATED: queue mutations belong to the local engine.
router.post('/queue/enqueue/:trackId', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'deprecated',
    message: 'Queue mutations are owned by the local engine. Use POST /api/playback/enqueue.',
  });
});

router.post('/queue/clear', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'deprecated',
    message: 'Queue mutations are owned by the local engine. Use POST /api/playback/clear.',
  });
});

export default router;
