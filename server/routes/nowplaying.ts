/**
 * Now Playing Relay
 *
 * Syncs from the local engine (authoritative source) and broadcasts to OBS
 * Browser Source and other viewer clients via SSE.
 *
 * GET  /api/nowplaying          — snapshot of current state
 * POST /api/nowplaying          — manual push (legacy browser controller compat)
 * GET  /api/nowplaying/stream   — SSE stream for viewer browsers / OBS
 */

import { Router, type Request, type Response } from 'express';

const router = Router();

// ── Shared state ──────────────────────────────────────────────────────────────

export interface NowPlayingTrackInfo {
  id:        string;
  title:     string;
  artist:    string;
  duration:  number;
  bpm:       number;
  genre?:    string;
  key?:      string;
}

export interface NowPlayingQueueItem {
  id:       string;
  title:    string;
  artist:   string;
  duration: number;
  bpm:      number | null;
  genre:    string;
}

export interface NowPlayingState {
  isPlaying:   boolean;
  track:       NowPlayingTrackInfo | null;
  progress:    number;   // 0–100
  currentTime: number;   // seconds
  queue:       NowPlayingQueueItem[];
  updatedAt:   number;   // ms epoch
  source:      'local-engine' | 'browser-push';
}

let _state: NowPlayingState = {
  isPlaying:   false,
  track:       null,
  progress:    0,
  currentTime: 0,
  queue:       [],
  updatedAt:   Date.now(),
  source:      'local-engine',
};

const _clients = new Set<Response>();

function _broadcast(): void {
  const payload = `data: ${JSON.stringify(_state)}\n\n`;
  for (const res of _clients) {
    try { res.write(payload); } catch { _clients.delete(res); }
  }
}

export function getNowPlayingState(): NowPlayingState {
  return JSON.parse(JSON.stringify(_state)) as NowPlayingState;
}

export function patchNowPlayingState(patch: Partial<NowPlayingState>): NowPlayingState {
  _state = { ..._state, ...patch, updatedAt: Date.now() };
  _broadcast();
  return getNowPlayingState();
}

/**
 * Called from server startup to keep nowplaying in sync with the local engine.
 * This replaces browser-push as the authoritative source for OBS / viewers.
 */
let _syncStarted = false;

export function startLocalEngineSync(): void {
  if (_syncStarted) return;
  _syncStarted = true;
  // Import here to avoid circular dependency at module load time
  Promise.all([
    import('../services/dj-local-engine.js'),
    import('../utils/music-scanner.js'),
  ]).then(([{ djLocalEngine }, { TrackStore }]) => {
    const SYNC_INTERVAL_MS = 1000;
    let lastTrackId: string | null = null;
    let lastMode: string | null = null;

    setInterval(async () => {
      try {
        const engineState = await djLocalEngine.refreshWorkerState();
        const ws = engineState.workerState;
        lastTrackId = engineState.currentTrackId;
        lastMode = engineState.mode;

        const storeTrack = engineState.currentTrackId
          ? TrackStore.getInstance().getById(engineState.currentTrackId)
          : null;

        const track: NowPlayingTrackInfo | null = engineState.currentTrackId
          ? {
              id:       engineState.currentTrackId,
              title:    engineState.currentTrackTitle ?? 'Unknown',
              artist:   engineState.currentTrackArtist ?? 'Unknown Artist',
              duration: ws?.durationSeconds ?? storeTrack?.duration ?? 0,
              bpm:      storeTrack?.bpm ?? 128,
            }
          : null;

        const queue: NowPlayingQueueItem[] = engineState.queue.map((item) => ({
          id:       item.queueItemId,
          title:    item.title,
          artist:   item.artist,
          duration: item.duration,
          bpm:      null,
          genre:    '',
        }));

        patchNowPlayingState({
          isPlaying:   engineState.mode === 'playing',
          track,
          progress:    ws && ws.durationSeconds > 0
                         ? Math.round((ws.positionSeconds / ws.durationSeconds) * 100)
                         : 0,
          currentTime: ws?.positionSeconds ?? 0,
          queue,
          source:      'local-engine',
        });
      } catch {
        // engine not ready — skip silently
      }
    }, SYNC_INTERVAL_MS);

    console.log('[NowPlaying] Local engine sync started (1s interval)');
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (_req: Request, res: Response) => {
  res.json(getNowPlayingState());
});

/** Legacy browser push — still accepted for compatibility but marked as such */
router.post('/', (req: Request, res: Response) => {
  const body = req.body as Partial<NowPlayingState>;
  // Only accept browser push if local engine isn't actively playing
  if (_state.source === 'local-engine' && _state.isPlaying) {
    res.json({ ok: true, ignored: true, reason: 'local engine is active authority' });
    return;
  }
  patchNowPlayingState({ ...body, source: 'browser-push' });
  res.json({ ok: true });
});

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(_state)}\n\n`);
  _clients.add(res);
  req.on('close', () => { _clients.delete(res); });
});

export default router;
