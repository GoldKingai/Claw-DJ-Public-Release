/**
 * OBS Control Routes
 *
 * GET  /api/obs/status       — connection + stream status
 * POST /api/obs/config       — set WebSocket URL + password
 * POST /api/obs/stream/start — start OBS streaming
 * POST /api/obs/stream/stop  — stop OBS streaming
 * GET  /api/obs/scenes       — list available scenes
 * POST /api/obs/scene        — switch to a scene
 */

import { safeErrorMessage } from '../utils/error-response.js';
import { Router, type Request, type Response } from 'express';
import { obsController } from '../services/obs-controller.js';

const router = Router();

// ── Status ─────────────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await obsController.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── Configure ──────────────────────────────────────────────────────────────────

router.post('/config', (req: Request, res: Response) => {
  const { url, password } = req.body as { url?: string; password?: string };
  obsController.configure(url || '', password || '');
  // Persist config so it survives service restarts
  obsController.saveConfig(url || '', password || '');
  res.json({ ok: true });
});

// ── Stream control ─────────────────────────────────────────────────────────────

router.post('/stream/start', async (_req: Request, res: Response) => {
  try {
    await obsController.startStreaming();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/stream/stop', async (_req: Request, res: Response) => {
  try {
    await obsController.stopStreaming();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── Scene management ───────────────────────────────────────────────────────────

router.get('/scenes', async (_req: Request, res: Response) => {
  try {
    const scenes = await obsController.listScenes();
    res.json({ scenes });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/scene', async (req: Request, res: Response) => {
  const { sceneName } = req.body as { sceneName?: string };
  if (!sceneName) {
    res.status(400).json({ error: 'sceneName is required' });
    return;
  }
  try {
    await obsController.setScene(sceneName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

export default router;
