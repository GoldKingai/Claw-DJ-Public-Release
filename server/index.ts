import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackStore } from './utils/music-scanner.js';
import { startWatching, stopWatching } from './utils/file-watcher.js';
import tracksRouter from './routes/tracks.js';
import healthRouter from './routes/health.js';
import directoriesRouter from './routes/directories.js';
import chatRouter from './routes/chat.js';
import metricsRouter from './routes/metrics.js';
import streamRouter from './routes/stream.js';
import broadcastRouter from './routes/broadcast.js';
import obsRouter from './routes/obs.js';
import schedulerRouter from './routes/scheduler.js';
import nowPlayingRouter, { startLocalEngineSync } from "./routes/nowplaying.js";
import controlRouter from './routes/control.js';
import recoveryRouter from './routes/recovery.js';
import playbackControlRouter from './routes/playback-control.js';
import djEngineRouter from './routes/dj-engine.js';
import djLocalEngineRouter from './routes/dj-local-engine.js';
import djBackendRouter from './routes/dj-backend.js';
import deckStreamRouter from './routes/deck-stream.js';
import ttsRouter from './routes/tts.js';
import sessionRouter from './routes/session.js';
import pollRouter from './routes/poll.js';
import shoutoutsRouter from './routes/shoutouts.js';
import adsRouter from './routes/ads.js';
import xRouter from './routes/x.js';
import modeRouter from './routes/mode.js';
import { youtubeChatService } from './services/youtube-chat.js';
import { startWatchdog, stopWatchdog, getWatchdogChatHandler, setWatchdogChatSender } from './services/watchdog.js';
import { youtubeMetricsService } from './services/youtube-metrics.js';
import { youtubeStreamDetector } from './services/youtube-stream-detector.js';
import { youtubeAuthService } from './services/youtube-auth.js';
import { obsController } from './services/obs-controller.js';
import { broadcastScheduler } from './services/broadcast-scheduler.js';
import { getSystemStatus } from './services/system-status.js';
import { apiAuth } from './utils/api-auth.js';
// Discord is handled by discord.js directly (see server/services/discord-service.ts).

// ── Global crash guards ──────────────────────────────────────────────────────
// Transient network errors (ECONNRESET etc.) must not kill the process.
process.on('uncaughtException', (err: Error) => {
  console.error('[Server] Uncaught exception (process kept alive):', err.message, err.stack?.split('\n')[1]?.trim() ?? '');
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[Server] Unhandled rejection (process kept alive):', msg);
});

const PORT = Number(process.env.PORT) || 3001;
const DEFAULT_MUSIC_DIR = process.platform === 'win32' ? 'D:/Music' : '/path/to/your/music';
const MUSIC_DIRS = (process.env.MUSIC_DIRS || DEFAULT_MUSIC_DIR)
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');

async function main() {
  console.log('========================================');
  console.log('  FlowDJ  —  Audio Server');
  console.log('========================================');
  console.log(`Music directories: ${MUSIC_DIRS.join(', ')}`);
  console.log('Scanning for audio files...');

  // ── Initial scan ─────────────────────────────────────────
  const store = TrackStore.getInstance();
  const startTime = Date.now();
  const added = await store.scanDirectories(MUSIC_DIRS);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`Found ${added} track${added === 1 ? '' : 's'} in ${elapsed}s`);

  // ── File watcher ─────────────────────────────────────────
  startWatching(MUSIC_DIRS);

  // ── Express app ──────────────────────────────────────────
  const app = express();

  // Allow an optional LLM gateway running on the same host (default port
  // 18789) to call our API from the browser. Harmless if you don't use one.
  const allowedOrigins = [
    'http://localhost:18789',
    'http://127.0.0.1:18789',
  ];
  app.use(cors({ origin: allowedOrigins, credentials: false }));
  // Explicit body-size limit (defence-in-depth against memory-exhaustion DoS
  // via huge JSON payloads). 256 KiB is well above any legitimate payload
  // this API handles — track IDs, short text, config blobs.
  app.use(express.json({ limit: '256kb' }));

  // Minimal security headers — cheap defence-in-depth. Frame-blocking
  // stops external embedding while still allowing the dashboard to be
  // used as an OBS Browser Source on the same host.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Optional shared-secret auth on mutating endpoints. No-op unless
  // API_TOKEN is set in .env — preserves current behaviour for trusted
  // LAN installs. When enabled, non-localhost POST/PUT/PATCH/DELETE
  // requires Authorization: Bearer <token>. See server/utils/api-auth.ts.
  app.use(apiAuth);

  app.use('/api/tracks', tracksRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/directories', directoriesRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api/stream', streamRouter);
  app.use('/api/broadcast', broadcastRouter);
  app.use('/api/obs', obsRouter);
  app.use('/api/scheduler', schedulerRouter);
  app.use('/api/nowplaying', nowPlayingRouter);
  app.use('/api/control', controlRouter);
  app.use('/api/recovery', recoveryRouter);
  app.use('/api/playback', playbackControlRouter);
  app.use('/api/dj-engine', djEngineRouter);
  app.use('/api/dj-local-engine', djLocalEngineRouter);
  app.use('/api/dj-backend', djBackendRouter);
  app.use('/api/deck-stream', deckStreamRouter);
  app.use('/api/tts', ttsRouter);
  app.use('/api/session', sessionRouter);
  app.use('/api/poll', pollRouter);
  app.use('/api/shoutouts', shoutoutsRouter);
  app.use('/api/ads', adsRouter);
  app.use('/api/x', xRouter);
  app.use('/api/mode', modeRouter);
  app.get('/api/status', (_req, res) => {
    res.json(getSystemStatus());
  });

  // ── TTS audio files ──────────────────────────────────────
  app.use('/tts-audio', express.static(path.join(DIST_DIR, 'tts-audio')));

  // ── Frontend (FlowDJ dashboard) ─────────────────────────
  app.use(express.static(DIST_DIR));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });

  // Wire watchdog as the YouTube chat response handler (dual-channel: TTS + chat post)
  // Also wire the chat sender into the watchdog so it can post to YouTube live chat
  setWatchdogChatSender((text) => youtubeChatService.sendChatMessage(text));
  youtubeChatService.setResponseHandler(getWatchdogChatHandler());

  // Fallback: if watchdog is not configured, direct Flow responses still work
  // (kept for reference — askFlow is now invoked by the watchdog internally)

  // Auto-configure YouTube services from environment variables if set.
  // Auth service first — broadcast management needs it.
  // Stream detector is the primary path — it auto-configures chat + metrics.
  youtubeAuthService.initFromEnv();
  youtubeStreamDetector.initFromEnv();
  youtubeChatService.initFromEnv();
  youtubeMetricsService.initFromEnv();
  obsController.initFromEnv();
  broadcastScheduler.start();
  startLocalEngineSync();
  startWatchdog();

  // Default to localhost-only binding. Set HOST=0.0.0.0 in .env to expose
  // on the LAN (needed if you run the dashboard browser source from a
  // different host). The default protects dev installs from accidental
  // LAN exposure; pair HOST=0.0.0.0 with API_TOKEN if you do open it up.
  const HOST = process.env.HOST || '127.0.0.1';
  app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      console.log('  WARNING: bound to all interfaces — API is reachable from the LAN.');
      console.log('  Endpoints have no auth; only do this on a trusted network.');
    }
    console.log('Routes:');
    console.log('  GET  /api/health');
    console.log('  GET  /api/tracks');
    console.log('  GET  /api/tracks/:id/stream');
    console.log('  GET  /api/directories');
    console.log('  POST /api/directories');
    console.log('  GET  /api/chat/stream  (SSE)');
    console.log('  GET  /api/chat/status');
    console.log('  POST /api/chat/config');
    console.log('  GET  /api/metrics/stream  (SSE)');
    console.log('  GET  /api/metrics/status');
    console.log('  POST /api/metrics/config');
    console.log('  GET  /api/stream/status');
    console.log('  POST /api/stream/config');
    console.log('  GET  /api/broadcast/auth/status');
    console.log('  POST /api/broadcast/auth/config');
    console.log('  GET  /api/broadcast/auth/url');
    console.log('  GET  /api/broadcast/auth/callback');
    console.log('  POST /api/broadcast/auth/revoke');
    console.log('  GET  /api/broadcast/status');
    console.log('  POST /api/broadcast/create');
    console.log('  POST /api/broadcast/go-live');
    console.log('  POST /api/broadcast/end');
    console.log('  GET  /api/broadcast/health');
    console.log('  GET  /api/obs/status');
    console.log('  POST /api/obs/config');
    console.log('  POST /api/obs/stream/start');
    console.log('  POST /api/obs/stream/stop');
    console.log('  GET  /api/obs/scenes');
    console.log('  POST /api/obs/scene');
    console.log('  GET  /api/control/queue');
    console.log('  POST /api/control/queue/clear');
    console.log('  POST /api/control/queue/remove');
    console.log('  POST /api/control/queue/move');
    console.log('  GET  /api/control/memory');
    console.log('  GET  /api/recovery/status');
    console.log('  POST /api/recovery/obs-reconnect');
    console.log('  POST /api/recovery/service/:name/restart');
    console.log('  GET  /api/playback/stream');
    console.log('  GET  /api/playback/history');
    console.log('  POST /api/playback/:action');
    console.log('  GET  /api/dj-engine/state');
    console.log('  POST /api/dj-engine/controller/heartbeat');
    console.log('  POST /api/dj-engine/controller/offline');
    console.log('  POST /api/dj-engine/sync');
    console.log('  POST /api/dj-engine/ack');
    console.log('  POST /api/dj-engine/queue/enqueue/:trackId');
    console.log('  POST /api/dj-engine/queue/clear');
    console.log('  GET  /api/dj-local-engine/state');
    console.log('  POST /api/dj-local-engine/crossfade');
    console.log('  POST /api/dj-local-engine/queue/enqueue/:trackId');
    console.log('  POST /api/dj-local-engine/queue/remove');
    console.log('  POST /api/dj-local-engine/queue/clear');
    console.log('  POST /api/dj-local-engine/play/:trackId');
    console.log('  POST /api/dj-local-engine/pause');
    console.log('  POST /api/dj-local-engine/resume');
    console.log('  POST /api/dj-local-engine/stop');
    console.log('  POST /api/dj-local-engine/skip');
    console.log('  GET  /api/dj-backend/plan');
    console.log('  GET  /api/status');
    console.log('  GET  /api/scheduler/state');
    console.log('  GET  /api/scheduler/schedule');
    console.log('  POST /api/scheduler/schedule');
    console.log('  PUT  /api/scheduler/schedule/:id');
    console.log('  DEL  /api/scheduler/schedule/:id');
    console.log('  POST /api/scheduler/start');
    console.log('  POST /api/scheduler/end');
    console.log('  POST /api/tts/speak');
    console.log('  GET  /api/tts/stream  (SSE)');
    console.log('  POST /api/session/start');
    console.log('  POST /api/session/end');
    console.log('  POST /api/session/track-played');
    console.log('  POST /api/session/set-plan');
    console.log('  POST /api/session/generate-plan');
    console.log('  GET  /api/session/state');
    console.log('  GET  /api/session/history');
    console.log('  GET  /api/session/available-tracks');
    console.log('  POST /api/chat/send');
    console.log('  GET  /api/chat/mood');
    console.log('  GET  /api/health/full');
    console.log('  GET  /api/tracks/stats');
    console.log('----------------------------------------');
  });

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...');
    stopWatchdog();
    broadcastScheduler.stop();
    await stopWatching();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
