/**
 * DeckStreamService — manages SSE connections to OBS Browser Source(s) and
 * bridges deck commands from dj-local-engine to the Web Audio player running
 * inside the browser source.
 *
 * Flow:
 *  server → dispatch(cmd) → SSE → browser (stream-deck.ts plays audio)
 *  browser → POST /api/deck-stream/state → reportState() → engine reads state
 */

import type { Response } from 'express';
import type { WorkerState } from './dj-local-worker-protocol.js';

// ── Command types sent TO the browser source ─────────────────────────────────

export type DeckCommand =
  | { type: 'play'; trackId: string; audioUrl: string; title?: string; artist?: string; duration?: number }
  | { type: 'preload'; trackId: string; audioUrl: string; title?: string; artist?: string; duration?: number }
  | { type: 'crossfade'; durationSeconds: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'seek'; positionSeconds: number }
  | { type: 'set-volume'; volume: number }
  | { type: 'duck'; targetVol?: number; rampSecs?: number }
  | { type: 'unduck'; rampSecs?: number }
  | { type: 'fade-to'; volume: number; rampSecs: number };

// ── State shape reported FROM the browser source ─────────────────────────────

export interface BrowserDeckState {
  mode: 'idle' | 'playing' | 'paused' | 'error';
  activeDeck: 'a' | 'b';
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  eosCount: number;
  rms: number;
  currentTrackId: string | null;
  currentTrackTitle: string | null;
  currentTrackArtist: string | null;
  lastError: string;
  updatedAt: number;
}

const DEFAULT_STATE: BrowserDeckState = {
  mode: 'idle',
  activeDeck: 'a',
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 1,
  eosCount: 0,
  rms: 0,
  currentTrackId: null,
  currentTrackTitle: null,
  currentTrackArtist: null,
  lastError: '',
  updatedAt: 0,
};

// ── Service ───────────────────────────────────────────────────────────────────

class DeckStreamService {
  private clients = new Set<Response>();
  private lastState: BrowserDeckState = { ...DEFAULT_STATE };

  // ── Client management ───────────────────────────────────────────────────────

  addClient(res: Response): void {
    this.clients.add(res);
    console.log(`[DeckStream] Browser source connected (${this.clients.size} client(s))`);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
    console.log(`[DeckStream] Browser source disconnected (${this.clients.size} client(s) remaining)`);
  }

  isConnected(): boolean {
    return this.clients.size > 0;
  }

  // ── Command dispatch ────────────────────────────────────────────────────────

  dispatch(command: DeckCommand): boolean {
    if (this.clients.size === 0) {
      console.warn(`[DeckStream] No browser source connected — command dropped: ${command.type}`);
      return false;
    }
    const payload = `data: ${JSON.stringify(command)}\n\n`;
    const dead: Response[] = [];
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        dead.push(res);
      }
    }
    for (const res of dead) this.clients.delete(res);
    return true;
  }

  // ── State from browser ──────────────────────────────────────────────────────

  reportState(state: BrowserDeckState): void {
    this.lastState = { ...state };
  }

  getLastBrowserState(): BrowserDeckState {
    return this.lastState;
  }

  // ── WorkerState adapter (for dj-local-engine compatibility) ─────────────────

  toWorkerState(): WorkerState {
    const s = this.lastState;
    return {
      protocolVersion: 2,
      workerId: 'browser-deck',
      mode: s.mode,
      currentTrack: s.currentTrackId
        ? {
            trackId: s.currentTrackId,
            uri: `/api/tracks/${s.currentTrackId}/stream`,
            title: s.currentTrackTitle ?? undefined,
            artist: s.currentTrackArtist ?? undefined,
            loadedAt: s.updatedAt,
          }
        : null,
      positionSeconds: s.positionSeconds,
      durationSeconds: s.durationSeconds,
      volume: s.volume,
      muted: false,
      buffering: false,
      eosCount: s.eosCount,
      currentPlaybackToken: null,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
      lastCommandAt: 0,
    };
  }
}

export const deckStreamService = new DeckStreamService();
