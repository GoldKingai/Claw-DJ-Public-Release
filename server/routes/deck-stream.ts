/**
 * Deck-stream routes — bridge between dj-local-engine and the Web Audio
 * player running inside the OBS Browser Source.
 *
 * GET  /api/deck-stream/commands  — SSE stream, browser source subscribes here
 * POST /api/deck-stream/state     — browser source reports its playback state
 */

import { Router, type Request, type Response } from 'express';
import { deckStreamService, type BrowserDeckState } from '../services/deck-stream-service.js';

const router = Router();

// ── GET /api/deck-stream/commands ─────────────────────────────────────────────
// OBS Browser Source subscribes here to receive deck commands.

router.get('/commands', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Initial keepalive so OBS doesn't close the connection immediately
  res.write(': connected\n\n');

  deckStreamService.addClient(res);

  // Keepalive ping every 20 s
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // Client gone — will be cleaned up on 'close'
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepalive);
    deckStreamService.removeClient(res);
  });
});

// ── POST /api/deck-stream/state ───────────────────────────────────────────────
// Browser source reports its current playback state (~every 200 ms + on EOS).

router.post('/state', (req: Request, res: Response) => {
  const body = req.body as Partial<BrowserDeckState>;

  if (!body || typeof body !== 'object' || typeof body.mode !== 'string') {
    res.status(400).json({ error: 'invalid state payload' });
    return;
  }

  deckStreamService.reportState({
    mode: body.mode as BrowserDeckState['mode'],
    activeDeck: body.activeDeck ?? 'a',
    positionSeconds: Number(body.positionSeconds ?? 0),
    durationSeconds: Number(body.durationSeconds ?? 0),
    volume: Number(body.volume ?? 1),
    eosCount: Number(body.eosCount ?? 0),
    rms: Number(body.rms ?? 0),
    currentTrackId: body.currentTrackId ?? null,
    currentTrackTitle: body.currentTrackTitle ?? null,
    currentTrackArtist: body.currentTrackArtist ?? null,
    lastError: body.lastError ?? '',
    updatedAt: Date.now(),
  });

  res.json({ ok: true });
});

export default router;
