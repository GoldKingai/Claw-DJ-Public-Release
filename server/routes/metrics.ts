/**
 * Metrics Routes
 *
 * GET  /api/metrics/stream   — SSE stream of viewer/subscriber snapshots
 * GET  /api/metrics/status   — config and snapshot status
 * POST /api/metrics/config   — set apiKey + videoId + channelId at runtime
 */

import { Router, type Request, type Response } from 'express';
import { youtubeMetricsService } from '../services/youtube-metrics.js';

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

  youtubeMetricsService.addClient(send);

  // Keep-alive every 30s
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(ping);
    youtubeMetricsService.removeClient(send);
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    configured: youtubeMetricsService.isConfigured,
    clients: youtubeMetricsService.clientCount,
    snapshot: youtubeMetricsService.snapshot,
  });
});

// ── Runtime configuration ─────────────────────────────────────────────────────

router.post('/config', (req: Request, res: Response) => {
  const { apiKey, videoId, channelId } = req.body as {
    apiKey?: string;
    videoId?: string;
    channelId?: string;
  };

  if (!apiKey || (!videoId && !channelId)) {
    res
      .status(400)
      .json({ error: 'apiKey and at least one of videoId or channelId are required' });
    return;
  }

  youtubeMetricsService.configure(apiKey, videoId ?? '', channelId ?? '');
  res.json({ ok: true, message: 'YouTube metrics polling started' });
});

export default router;
