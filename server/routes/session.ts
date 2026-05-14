/**
 * Session Routes
 *
 * POST /api/session/start          — begin a genre session
 * POST /api/session/end            — end current session
 * POST /api/session/track-played   — record a track as played
 * POST /api/session/set-plan       — set tonight's full session plan
 * POST /api/session/generate-plan  — auto-generate a night plan
 * GET  /api/session/state          — current session state
 * GET  /api/session/history        — past session log
 * GET  /api/session/available-tracks — tracks available in current genre
 */

import { Router, type Request, type Response } from 'express';
import { sessionManager, type SessionPlan } from '../services/session-manager.js';
import { youtubeBroadcastService } from '../services/youtube-broadcast.js';
import { resetSessionFlags, fireStreamStart, getWatchdogDebugState } from '../services/watchdog.js';
import { djLocalEngine } from '../services/dj-local-engine.js';
import { modeManager } from '../services/mode-manager.js';

const router = Router();

/** POST /api/session/start */
router.post('/start', (req: Request, res: Response) => {
  const { genre, durationMins, nextGenre, nightPlan } = req.body as {
    genre?: string;
    durationMins?: number;
    nextGenre?: string;
    nightPlan?: SessionPlan[];
  };

  if (!genre?.trim()) {
    res.status(400).json({ ok: false, error: 'genre required' });
    return;
  }

  const normalised = genre.trim().toLowerCase();
  const state = sessionManager.start(
    normalised,
    typeof durationMins === 'number' ? durationMins : 60,
    nextGenre?.trim().toLowerCase() ?? null,
    nightPlan,
  );

  // Reset watchdog per-session flags so warnings/milestones fire fresh
  resetSessionFlags();
  // Fire welcome sequence on first active session each stream
  fireStreamStart();

  // Update broadcast title to reflect the current genre (non-blocking)
  const titleGenre = normalised.charAt(0).toUpperCase() + normalised.slice(1);
  youtubeBroadcastService.updateTitle(`Claw DJ — ${titleGenre} Session`).catch(() => {});

  res.json({ ok: true, state });
});

/** POST /api/session/end */
router.post('/end', (_req: Request, res: Response) => {
  const state = sessionManager.end();
  res.json({ ok: true, state });
});

/** POST /api/session/track-played */
router.post('/track-played', (req: Request, res: Response) => {
  const { trackId } = req.body as { trackId?: string };
  if (!trackId?.trim()) {
    res.status(400).json({ ok: false, error: 'trackId required' });
    return;
  }
  const state = sessionManager.trackPlayed(trackId.trim());
  res.json({ ok: true, state });
});

/** POST /api/session/set-plan */
router.post('/set-plan', (req: Request, res: Response) => {
  const { nightPlan } = req.body as { nightPlan?: SessionPlan[] };
  if (!Array.isArray(nightPlan)) {
    res.status(400).json({ ok: false, error: 'nightPlan array required' });
    return;
  }
  const state = sessionManager.setPlan(nightPlan);
  res.json({ ok: true, state });
});

/** POST /api/session/generate-plan */
router.post('/generate-plan', (req: Request, res: Response) => {
  const { streamDurationMins, currentHour } = req.body as {
    streamDurationMins?: number;
    currentHour?: number;
  };
  const duration = typeof streamDurationMins === 'number' ? streamDurationMins : 240;
  const hour = typeof currentHour === 'number' ? currentHour : new Date().getHours();

  const nightPlan = sessionManager.generateNightPlan(duration, hour);
  res.json({ ok: true, nightPlan });
});

/** GET /api/session/state */
router.get('/state', (_req: Request, res: Response) => {
  const state = sessionManager.snapshot();
  const elapsedMins = Math.round(sessionManager.elapsedMins * 10) / 10;
  const remainingMins = Math.round(sessionManager.remainingMins * 10) / 10;
  const endsAt = state.startedAt > 0
    ? state.startedAt + state.plannedDurationMins * 60_000
    : null;
  const watchdog = getWatchdogDebugState();
  res.json({ ok: true, state, elapsedMins, remainingMins, endsAt, watchdog });
});

/** GET /api/session/history */
router.get('/history', (_req: Request, res: Response) => {
  res.json({ ok: true, history: sessionManager.getHistory() });
});

/** GET /api/session/available-tracks — tracks not yet played in current genre session */
router.get('/available-tracks', (_req: Request, res: Response) => {
  const tracks = sessionManager.getAvailableTracks();
  res.json({ ok: true, count: tracks.length, tracks });
});

/**
 * POST /api/session/start-auto
 * One-click "Start DJ" — generates a night plan, starts the first genre block,
 * kicks the first track. Watchdog handles everything else (queue refill,
 * crossfades, genre transitions) autonomously.
 *
 * Body (all optional):
 *   - mode: 'local' | 'live'           (defaults to current mode)
 *   - streamDurationMins: number       (default 240 = 4h night)
 *   - currentHour: number              (default = now)
 *
 * Returns: { ok, mode, nightPlan, state, currentTrack }
 */
router.post('/start-auto', async (req: Request, res: Response) => {
  const {
    mode,
    streamDurationMins,
    currentHour,
  } = req.body as {
    mode?: 'local' | 'live';
    streamDurationMins?: number;
    currentHour?: number;
  };

  // Switch mode if requested
  if (mode === 'local' || mode === 'live') {
    modeManager.setMode(mode);
  }

  const duration = typeof streamDurationMins === 'number' ? streamDurationMins : 240;
  const hour = typeof currentHour === 'number' ? currentHour : new Date().getHours();

  // 1. Generate night plan
  const nightPlan = sessionManager.generateNightPlan(duration, hour);
  if (!nightPlan || nightPlan.length === 0) {
    res.status(500).json({ ok: false, error: 'No tracks available — add a music folder first' });
    return;
  }

  // 2. Start session on first genre block
  const first = nightPlan[0];
  const nextGenre = nightPlan[1]?.genre ?? null;
  const state = sessionManager.start(first.genre, first.durationMins, nextGenre, nightPlan);
  resetSessionFlags();
  fireStreamStart();

  // 3. Kick the first track immediately so audio starts now (watchdog
  //    would do this on its next tick anyway, but this removes the lag).
  const firstTrackId = first.trackIds?.[0];
  let currentTrack: string | null = null;
  if (firstTrackId) {
    try {
      const engineState = await djLocalEngine.playNow(firstTrackId);
      currentTrack = engineState.currentTrackTitle ?? null;
    } catch (e) {
      console.warn('[session/start-auto] playNow failed, watchdog will retry:', (e as Error).message);
    }
  }

  res.json({
    ok: true,
    mode: modeManager.mode,
    nightPlan,
    state,
    currentTrack,
  });
});

/**
 * POST /api/session/stop-auto
 * Stops everything — ends session, clears queue, stops playback.
 * Watchdog will stop enqueuing new tracks since session is no longer active.
 */
router.post('/stop-auto', async (_req: Request, res: Response) => {
  const sessionState = sessionManager.end();
  try {
    djLocalEngine.clearQueue();
    await djLocalEngine.stop();
  } catch (e) {
    console.warn('[session/stop-auto] engine stop error:', (e as Error).message);
  }
  res.json({ ok: true, state: sessionState });
});

export default router;
