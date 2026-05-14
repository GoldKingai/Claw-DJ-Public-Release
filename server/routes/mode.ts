/**
 * Mode Route — switch between 'local' (party DJ) and 'live' (full stream).
 *
 *   GET  /api/mode         → { mode, changedAt }
 *   POST /api/mode         → { mode: 'local' | 'live' } → { ok, mode }
 */

import { Router, type Request, type Response } from 'express';
import { modeManager } from '../services/mode-manager.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(modeManager.getState());
});

router.post('/', (req: Request, res: Response) => {
  const next = req.body?.mode;
  if (next !== 'local' && next !== 'live') {
    res.status(400).json({ error: 'mode must be "local" or "live"' });
    return;
  }
  try {
    modeManager.setMode(next);
    res.json({ ok: true, mode: modeManager.mode });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
