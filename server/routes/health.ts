import { Router, type Request, type Response } from 'express';
import { TrackStore } from '../utils/music-scanner.js';
import { djLocalEngine } from '../services/dj-local-engine.js';
import { sessionManager } from '../services/session-manager.js';
import { youtubeChatService } from '../services/youtube-chat.js';
import { youtubeMetricsService } from '../services/youtube-metrics.js';
import { youtubeStreamDetector } from '../services/youtube-stream-detector.js';

const router = Router();

/** GET /api/health — basic health check (used by monitoring) */
router.get('/', async (_req: Request, res: Response) => {
  const store = TrackStore.getInstance();
  const local = await djLocalEngine.refreshWorkerState();
  const localHealthy = local.mode !== 'error' && local.workerConnected;

  res.json({
    status: localHealthy ? 'ok' : 'degraded',
    tracks: store.count,
    uptime: process.uptime(),
    localEngine: {
      mode: local.mode,
      healthy: localHealthy,
      lastError: local.lastError,
      workerConnected: local.workerConnected,
    },
  });
});

/** GET /api/health/full — complete system snapshot */
router.get('/full', async (_req: Request, res: Response) => {
  const store = TrackStore.getInstance();

  // Engine state
  const engine = await djLocalEngine.refreshWorkerState();

  // Session state
  const session = sessionManager.snapshot();
  const elapsedMins = Math.round(sessionManager.elapsedMins * 10) / 10;

  // Library stats
  const all = store.getAll();
  const byGenre: Record<string, number> = {};
  for (const t of all) {
    const g = t.genre?.toLowerCase().trim() || 'unknown';
    byGenre[g] = (byGenre[g] ?? 0) + 1;
  }
  const thinGenres = Object.entries(byGenre).filter(([, c]) => c < 5).map(([g]) => g);

  // Broadcast status
  let isLive = false;
  let viewerCount = 0;
  let chatConnected = youtubeChatService.isConfigured;

  try {
    isLive = youtubeStreamDetector.status?.isLive ?? false;
  } catch { /* detector may not expose state */ }

  try {
    viewerCount = youtubeMetricsService.snapshot?.viewers ?? 0;
  } catch { /* metrics may not be available */ }

  res.json({
    engine: {
      mode: engine.mode,
      currentTrack: engine.currentTrackTitle
        ? `${engine.currentTrackTitle} — ${engine.currentTrackArtist}`
        : null,
      currentTrackId: engine.currentTrackId,
      queueDepth: engine.queue.length,
      workerConnected: engine.workerConnected,
      crossfadeSeconds: engine.crossfadeSeconds,
      lastError: engine.lastError || null,
    },
    session: {
      status: session.status,
      genre: session.genre || null,
      elapsedMins,
      plannedDurationMins: session.plannedDurationMins,
      remainingMins: Math.round(sessionManager.remainingMins * 10) / 10,
      tracksPlayed: session.tracksPlayedIds.length,
      nextGenre: session.nextGenre,
      nightPlan: session.nightPlan,
    },
    broadcast: {
      isLive,
      viewerCount,
      chatConnected,
    },
    library: {
      totalTracks: all.length,
      byGenre,
      thinGenres,
    },
    server: {
      uptime: Math.round(process.uptime()),
      uptimeFormatted: _formatUptime(process.uptime()),
    },
  });
});

function _formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}h ${m}m ${s}s`;
}

export default router;
