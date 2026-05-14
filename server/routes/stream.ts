/**
 * Stream Detection Routes
 *
 * GET  /api/stream/status  — current live stream detection state
 * POST /api/stream/config  — set apiKey + channelId to start auto-detection
 */

import { Router, type Request, type Response } from 'express';
import { youtubeStreamDetector } from '../services/youtube-stream-detector.js';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    configured: youtubeStreamDetector.isConfigured,
    ...youtubeStreamDetector.status,
  });
});

// ── Runtime configuration ─────────────────────────────────────────────────────

router.post('/config', (req: Request, res: Response) => {
  const { apiKey, channelId } = req.body as {
    apiKey?: string;
    channelId?: string;
  };

  if (!apiKey || !channelId) {
    res.status(400).json({ error: 'apiKey and channelId are required' });
    return;
  }

  youtubeStreamDetector.configure(apiKey, channelId);
  res.json({ ok: true, message: 'Stream detection started' });
});

export default router;
