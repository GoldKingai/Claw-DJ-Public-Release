/**
 * Shoutout Manager (Revenue — Phase 5.1)
 *
 * Manages paid/gifted shoutouts that appear on the avatar's ad banner
 * and are announced via Flow TTS.
 *
 * Flow:
 *   1. External system (donation webhook, manual trigger, etc.) calls addShoutout()
 *   2. The shoutout enters a queue (FIFO)
 *   3. Server-Sent Events push the next shoutout to any connected display client
 *   4. After acknowledgement (or timeout), the next shoutout is served
 *
 * The display client (avatar-viewport / obs-deck) listens on GET /api/shoutouts/stream
 * and calls showAd() on the ad banner when it receives a shoutout event.
 */

export interface Shoutout {
  id: string;
  /** Display name of the supporter */
  name: string;
  /** Optional message from the supporter */
  message?: string;
  /** Optional amount (for rendering — e.g. "£5", "100 bits") */
  amount?: string;
  /** Optional image URL for the supporter's avatar */
  imageUrl?: string;
  /** Duration to display (seconds, default 10) */
  displaySecs: number;
  /** ms epoch when added to queue */
  addedAt: number;
  /** Status tracking */
  status: 'queued' | 'displayed' | 'expired';
}

type SSEClient = (data: object) => void;

const DEFAULT_DISPLAY_SECS = 10;
const SHOUTOUT_TTL_MS = 30 * 60 * 1000; // expire queued shoutouts after 30 min

class ShoutoutManagerService {
  private _queue: Shoutout[] = [];
  private _history: Shoutout[] = [];
  private _sseClients = new Set<SSEClient>();
  private _displayTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentShoutout: Shoutout | null = null;

  // ── SSE client management ──────────────────────────────────────────────────

  addClient(client: SSEClient): void {
    this._sseClients.add(client);
    // Send current shoutout immediately if one is showing
    if (this._currentShoutout) {
      client({ type: 'shoutout', shoutout: this._currentShoutout });
    }
  }

  removeClient(client: SSEClient): void {
    this._sseClients.delete(client);
  }

  private _broadcast(data: object): void {
    for (const client of this._sseClients) {
      try {
        client(data);
      } catch {
        this._sseClients.delete(client);
      }
    }
  }

  // ── Queue management ────────────────────────────────────────────────────────

  /**
   * Add a shoutout to the queue.
   * Returns the created shoutout object.
   */
  add(shoutout: Omit<Shoutout, 'id' | 'addedAt' | 'status'>): Shoutout {
    const entry: Shoutout = {
      ...shoutout,
      id: `so_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      displaySecs: shoutout.displaySecs ?? DEFAULT_DISPLAY_SECS,
      addedAt: Date.now(),
      status: 'queued',
    };

    this._queue.push(entry);
    console.log(`[Shoutout] Queued: ${entry.name}${entry.amount ? ` (${entry.amount})` : ''}`);

    // If nothing is currently displaying, kick off the queue
    if (!this._currentShoutout) {
      this._showNext();
    }

    return entry;
  }

  /** Get current queue (excluding history). */
  get queue(): Shoutout[] {
    return [...this._queue];
  }

  /** Get recent history (last 50 displayed shoutouts). */
  get history(): Shoutout[] {
    return [...this._history].reverse();
  }

  /** Whether a shoutout is currently being displayed. */
  get isDisplaying(): boolean {
    return !!this._currentShoutout;
  }

  /** Currently displaying shoutout (null if idle). */
  get current(): Shoutout | null {
    return this._currentShoutout ? { ...this._currentShoutout } : null;
  }

  // ── Display cycle ───────────────────────────────────────────────────────────

  private _showNext(): void {
    this._clearTimer();

    // Prune expired entries
    const now = Date.now();
    this._queue = this._queue.filter(s => now - s.addedAt < SHOUTOUT_TTL_MS);

    if (this._queue.length === 0) {
      this._currentShoutout = null;
      this._broadcast({ type: 'idle' });
      return;
    }

    const next = this._queue.shift()!;
    next.status = 'displayed';
    this._currentShoutout = next;

    console.log(`[Shoutout] Displaying: ${next.name} (${next.displaySecs}s)`);
    this._broadcast({ type: 'shoutout', shoutout: next });

    // Auto-advance after display duration
    this._displayTimer = setTimeout(() => {
      if (this._currentShoutout?.id === next.id) {
        next.status = 'expired';
        this._history.push(next);
        if (this._history.length > 50) this._history.shift();
        this._currentShoutout = null;
        this._showNext();
      }
    }, next.displaySecs * 1000);
  }

  /** Acknowledge / skip current shoutout early (call after TTS completes). */
  acknowledge(): void {
    if (!this._currentShoutout) return;
    this._clearTimer();
    this._currentShoutout.status = 'expired';
    this._history.push(this._currentShoutout);
    if (this._history.length > 50) this._history.shift();
    this._currentShoutout = null;
    this._showNext();
  }

  /** Clear all queued (not yet displayed) shoutouts. */
  clearQueue(): void {
    this._queue = [];
  }

  private _clearTimer(): void {
    if (this._displayTimer) {
      clearTimeout(this._displayTimer);
      this._displayTimer = null;
    }
  }
}

export const shoutoutManager = new ShoutoutManagerService();
