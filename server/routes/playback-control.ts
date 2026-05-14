/**
 * Canonical playback control API.
 *
 * Read:  GET  /api/playback/state     — authoritative engine state
 * Write: POST /api/playback/commands  — single execution path for all mutations
 *
 * Legacy routes (POST /api/playback/:action, SSE stream, ack) are kept for
 * compatibility but route through the same execution logic.
 */

import { Router, type Request, type Response } from 'express';
import { djLocalEngine } from '../services/dj-local-engine.js';

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlaybackCommandType =
  | 'enqueue'
  | 'play-track-now'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'skip'
  | 'seek'
  | 'set-volume'
  | 'remove-queue-item'
  | 'clear-queue'
  | 'move-queue-item'
  | 'preload'
  | 'crossfade'
  | 'set-crossfade'
  | 'duck'
  | 'unduck'
  | 'fade-to';

interface PlaybackCommandRequest {
  requestId?: string;
  type: PlaybackCommandType;
  payload?: Record<string, unknown>;
}

interface PlaybackCommandResponse {
  ok: boolean;
  requestId: string;
  type: PlaybackCommandType;
  authority: 'local-engine';
  state?: unknown;
  error?: { code: string; message: string };
}

// Legacy SSE command shape (kept for stream/ack endpoints)
interface LegacyCommand {
  id: string;
  action: string;
  createdAt: number;
  params?: Record<string, unknown>;
  status?: 'pending' | 'acked' | 'failed';
  ackedAt?: number;
  error?: string;
}

// ── SSE client registry (legacy controller bridge) ────────────────────────────

const sseClients = new Set<Response>();
let sseHistory: LegacyCommand[] = [];

function sseBroadcast(command: LegacyCommand): void {
  const payload = `data: ${JSON.stringify(command)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── Core command executor ─────────────────────────────────────────────────────

let _reqCounter = 0;
function nextRequestId(): string {
  return `cmd_${Date.now()}_${++_reqCounter}`;
}

async function executeCommand(
  type: PlaybackCommandType,
  payload: Record<string, unknown> = {},
  requestId: string,
): Promise<PlaybackCommandResponse> {
  const base: PlaybackCommandResponse = {
    ok: false,
    requestId,
    type,
    authority: 'local-engine',
  };

  try {
    switch (type) {
      case 'enqueue': {
        const trackId = String(payload['trackId'] ?? '');
        if (!trackId) return { ...base, error: { code: 'INVALID_PARAMS', message: 'trackId required' } };
        const state = djLocalEngine.enqueue(trackId, (payload['source'] as any) ?? 'manual');
        if (state.lastError) return { ...base, error: { code: 'NOT_FOUND', message: state.lastError } };
        return { ...base, ok: true, state };
      }
      case 'play-track-now': {
        const trackId = String(payload['trackId'] ?? '');
        if (!trackId) return { ...base, error: { code: 'INVALID_PARAMS', message: 'trackId required' } };
        return { ...base, ok: true, state: await djLocalEngine.playNow(trackId) };
      }
      case 'pause':
        return { ...base, ok: true, state: await djLocalEngine.pause() };
      case 'resume':
        return { ...base, ok: true, state: await djLocalEngine.resume() };
      case 'stop':
        return { ...base, ok: true, state: await djLocalEngine.stop() };
      case 'skip':
        return { ...base, ok: true, state: await djLocalEngine.skip() };
      case 'seek': {
        const pos = Number(payload['positionSeconds']);
        if (!Number.isFinite(pos)) return { ...base, error: { code: 'INVALID_PARAMS', message: 'positionSeconds required' } };
        return { ...base, ok: true, state: await djLocalEngine.seek(pos) };
      }
      case 'set-volume': {
        const vol = Number(payload['volume']);
        if (!Number.isFinite(vol)) return { ...base, error: { code: 'INVALID_PARAMS', message: 'volume required' } };
        return { ...base, ok: true, state: await djLocalEngine.setVolume(vol) };
      }
      case 'remove-queue-item': {
        const queueItemId = String(payload['queueItemId'] ?? '');
        if (queueItemId) return { ...base, ok: true, state: djLocalEngine.removeQueueById(queueItemId) };
        const index = Number(payload['index']);
        if (Number.isFinite(index)) return { ...base, ok: true, state: djLocalEngine.removeQueueIndex(index) };
        return { ...base, error: { code: 'INVALID_PARAMS', message: 'queueItemId or index required' } };
      }
      case 'clear-queue':
        return { ...base, ok: true, state: djLocalEngine.clearQueue() };
      case 'move-queue-item': {
        const from = Number(payload['fromIndex']);
        const to = Number(payload['toIndex']);
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          return { ...base, error: { code: 'INVALID_PARAMS', message: 'fromIndex and toIndex required' } };
        }
        return { ...base, ok: true, state: djLocalEngine.moveQueueItem(from, to) };
      }
      case 'preload': {
        const trackId = String(payload['trackId'] ?? '');
        if (!trackId) return { ...base, error: { code: 'INVALID_PARAMS', message: 'trackId required' } };
        return { ...base, ok: true, state: await djLocalEngine.preload(trackId) };
      }
      case 'crossfade': {
        const dur = Number(payload['durationSeconds'] ?? 6);
        return { ...base, ok: true, state: await djLocalEngine.crossfade(dur) };
      }
      case 'set-crossfade': {
        const secs = Number(payload['durationSeconds'] ?? 6);
        if (!Number.isFinite(secs)) return { ...base, error: { code: 'INVALID_PARAMS', message: 'durationSeconds required' } };
        return { ...base, ok: true, state: djLocalEngine.setCrossfadeSeconds(secs) };
      }
      case 'duck': {
        const targetVol = Number(payload['targetVol'] ?? 0.18);
        const rampSecs  = Number(payload['rampSecs']  ?? 0.4);
        djLocalEngine.duck(targetVol, rampSecs);
        return { ...base, ok: true };
      }
      case 'unduck': {
        const rampSecs = Number(payload['rampSecs'] ?? 0.8);
        djLocalEngine.unduck(rampSecs);
        return { ...base, ok: true };
      }
      case 'fade-to': {
        const vol      = Number(payload['volume']   ?? 1);
        const rampSecs = Number(payload['rampSecs'] ?? 1);
        djLocalEngine.fadeTo(vol, rampSecs);
        return { ...base, ok: true };
      }
      default:
        return { ...base, error: { code: 'UNKNOWN_COMMAND', message: `unknown command type: ${type}` } };
    }
  } catch (err) {
    return {
      ...base,
      error: {
        code: 'EXECUTION_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Canonical state read */
router.get('/state', async (_req: Request, res: Response) => {
  const state = await djLocalEngine.refreshWorkerState();
  res.json({ ok: true, authority: 'local-engine', state });
});

/** Canonical command write */
router.post('/commands', async (req: Request, res: Response) => {
  const body = req.body as PlaybackCommandRequest;
  const type = body?.type;
  const payload = body?.payload ?? {};
  const requestId = body?.requestId ?? nextRequestId();

  const validTypes = new Set<PlaybackCommandType>([
    'enqueue', 'play-track-now', 'pause', 'resume', 'stop', 'skip',
    'seek', 'set-volume', 'remove-queue-item', 'clear-queue', 'move-queue-item',
    'preload', 'crossfade', 'set-crossfade', 'duck', 'unduck', 'fade-to',
  ]);

  if (!type || !validTypes.has(type)) {
    res.status(400).json({
      ok: false,
      requestId: requestId ?? nextRequestId(),
      authority: 'local-engine',
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `valid types: ${[...validTypes].join(', ')}`,
      },
    });
    return;
  }

  const result = await executeCommand(type, payload, requestId);
  res.status(result.ok ? 200 : result.error?.code === 'NOT_FOUND' ? 404 : result.error?.code === 'INVALID_PARAMS' ? 400 : 500).json(result);
});

// ── Legacy SSE bridge (browser controller compatibility) ──────────────────────

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

router.get('/history', (_req: Request, res: Response) => {
  res.json({ controlOwner: 'local-engine', history: sseHistory });
});

router.post('/ack/:id', (req: Request, res: Response) => {
  const id = req.params['id'];
  const cmd = sseHistory.find((c) => c.id === id);
  if (!cmd) { res.status(404).json({ error: 'command not found' }); return; }
  cmd.status = 'acked';
  cmd.ackedAt = Date.now();
  res.json({ ok: true, command: cmd });
});

router.post('/fail/:id', (req: Request, res: Response) => {
  const id = req.params['id'];
  const { error } = req.body as { error?: string };
  const cmd = sseHistory.find((c) => c.id === id);
  if (!cmd) { res.status(404).json({ error: 'command not found' }); return; }
  cmd.status = 'failed';
  cmd.ackedAt = Date.now();
  cmd.error = error ?? 'unknown failure';
  res.json({ ok: true, command: cmd });
});

// ── Legacy action route — shim to POST /commands ─────────────────────────────

const LEGACY_ACTION_MAP: Record<string, PlaybackCommandType> = {
  pause: 'pause',
  resume: 'resume',
  skip: 'skip',
  stop: 'stop',
  clear: 'clear-queue',
  enqueue: 'enqueue',
  'play-track': 'play-track-now',
  'remove-queue-item': 'remove-queue-item',
  seek: 'seek',
  'set-volume': 'set-volume',
};

router.post('/:action', async (req: Request, res: Response) => {
  const legacyAction = String(req.params['action'] ?? '');
  const type = LEGACY_ACTION_MAP[legacyAction];

  if (!type) {
    res.status(400).json({
      error: `unknown action. use POST /api/playback/commands with type: one of ${Object.keys(LEGACY_ACTION_MAP).join(', ')}`,
    });
    return;
  }

  // Normalize legacy param shapes to payload
  const rawBody = req.body as Record<string, unknown> ?? {};
  const payload: Record<string, unknown> = { ...rawBody };

  // Legacy enqueue used params.trackId; new path also uses payload.trackId
  // Legacy play-track used params.trackId
  // Legacy remove-queue-item used params.index
  // (no transform needed — shapes match)

  const requestId = nextRequestId();
  const result = await executeCommand(type, payload, requestId);

  // Also publish to SSE history for legacy controller
  const legacyCmd: LegacyCommand = {
    id: requestId,
    action: legacyAction,
    createdAt: Date.now(),
    params: payload,
    status: result.ok ? 'acked' : 'failed',
    ackedAt: Date.now(),
    error: result.error?.message,
  };
  sseHistory.push(legacyCmd);
  if (sseHistory.length > 100) sseHistory = sseHistory.slice(-100);
  sseBroadcast(legacyCmd);

  res.status(result.ok ? 200 : 400).json({ local: true, ...result });
});

export default router;
