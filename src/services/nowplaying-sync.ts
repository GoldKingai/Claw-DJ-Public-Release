/**
 * Now Playing Sync
 *
 * Two-mode service that bridges the AI DJ's client-side playback state with
 * any other browser instance (including OBS Browser Source).
 *
 * PUSH mode  — used by the controller browser (no ?stream param).
 *   Watches aiDjService and POSTs state to /api/nowplaying on every change
 *   and every 5 s for progress updates.
 *
 * RECEIVE mode — used by viewer browsers (?stream=1, OBS Browser Source).
 *   Subscribes to /api/nowplaying/stream SSE and exposes live state via
 *   startReceiving(callback).
 */

import { aiDjService, type QueuedTrack } from './ai-dj-service.js';

// ── Public state type exposed to consumers ─────────────────────────────────────

export interface RemoteTrack {
  id:       string;
  title:    string;
  artist:   string;
  duration: number;
  bpm:      number;
  genre?:   string;
  key?:     string;
}

export interface RemoteNowPlaying {
  isPlaying:   boolean;
  track:       RemoteTrack | null;
  progress:    number;    // 0–100
  currentTime: number;    // seconds
  queue:       QueuedTrack[];
  updatedAt:   number;
}

type ReceiveCallback = (state: RemoteNowPlaying) => void;

// ── Service ───────────────────────────────────────────────────────────────────

class NowPlayingSync {
  private _unsubDj:      (() => void) | null = null;
  private _pushTimer:    number | null       = null;
  private _pollTimer:    number | null       = null;
  private _listeners:    Set<ReceiveCallback> = new Set();
  private _lastUpdatedAt = 0;

  // ── Push mode (controller browser) ──────────────────────────────────────────

  /**
   * Start watching aiDjService and pushing state to the server.
   * Call this once from the controller browser on startup.
   */
  startPushing(): void {
    if (this._unsubDj) return; // already running
    this._unsubDj  = aiDjService.onChange(() => void this._push());
    // Progress ticks between track-change events
    this._pushTimer = window.setInterval(() => {
      if (aiDjService.isPlaying) void this._push();
    }, 5_000);
  }

  stopPushing(): void {
    if (this._unsubDj) { this._unsubDj(); this._unsubDj = null; }
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
  }

  private async _push(): Promise<void> {
    const track = aiDjService.currentTrack;
    const body: RemoteNowPlaying = {
      isPlaying:   aiDjService.isPlaying,
      track:       track
        ? {
            id:       track.id,
            title:    track.title,
            artist:   track.artist,
            duration: track.duration,
            bpm:      track.bpm ?? 128,
            genre:    track.genre,
          }
        : null,
      progress:    aiDjService.duration > 0
        ? (aiDjService.currentTime / aiDjService.duration) * 100
        : 0,
      currentTime: aiDjService.currentTime,
      queue:       aiDjService.queue,
      updatedAt:   Date.now(),
    };

    try {
      await fetch('/api/nowplaying', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
    } catch {
      // server not reachable — silently ignore
    }
  }

  // ── Receive mode (OBS Browser Source / viewer) ───────────────────────────────

  /**
   * Subscribe to live state from the server (polled every 2 s).
   * Returns an unsubscribe function.
   */
  startReceiving(cb: ReceiveCallback): () => void {
    this._listeners.add(cb);
    if (!this._pollTimer) this._startPoll();
    return () => {
      this._listeners.delete(cb);
      if (this._listeners.size === 0) this._stopPoll();
    };
  }

  private _startPoll(): void {
    const poll = async () => {
      try {
        const res = await fetch('/api/nowplaying');
        if (!res.ok) return;
        const state = await res.json() as RemoteNowPlaying;
        if (!state || state.updatedAt === this._lastUpdatedAt) return;
        this._lastUpdatedAt = state.updatedAt;
        this._listeners.forEach(cb => cb(state));
      } catch { /* network error — retry next interval */ }
    };
    void poll();
    this._pollTimer = window.setInterval(poll, 2_000);
  }

  private _stopPoll(): void {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }
}

export const nowPlayingSync = new NowPlayingSync();
