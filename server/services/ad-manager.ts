/**
 * Ad Manager — three independent placement slots for paid advertisements.
 *
 * Slot 1 — DJ Booth front banner  (premium)
 * Slot 2 — Back Left TV screen
 * Slot 3 — Back Right TV screen
 *
 * Each booking has a total duration (`expiresAt`). Short bookings (≤5 min)
 * display once for the full duration. Longer bookings loop every `displaySecs`
 * for the life of the booking so the ad reappears throughout the stream.
 */

export type AdSlot = 1 | 2 | 3;

export interface AdBooking {
  id: string;
  slot: AdSlot;
  headline: string;
  body?: string;
  imageUrl?: string;
  bgColor?: string;
  accentColor?: string;
  /** Seconds the ad shows per appearance */
  displaySecs: number;
  /** MS epoch — keep looping until this time */
  expiresAt: number;
  addedAt: number;
  status: 'active' | 'expired' | 'cancelled';
}

// ── Pricing ───────────────────────────────────────────────────────────────────

export interface AdTier {
  key: string;
  label: string;
  /** Total booking duration in seconds */
  durationSecs: number;
  /** Default display-per-appearance in seconds */
  displaySecs: number;
  /** Price in pence (GBP) per slot */
  pricePence: Record<AdSlot, number>;
}

export const AD_TIERS: AdTier[] = [
  {
    key: '30s',  label: '30 seconds', durationSecs: 30,     displaySecs: 30,
    pricePence:  { 1: 250,   2: 100,   3: 100   },
  },
  {
    key: '1m',   label: '1 minute',   durationSecs: 60,     displaySecs: 60,
    pricePence:  { 1: 400,   2: 175,   3: 175   },
  },
  {
    key: '5m',   label: '5 minutes',  durationSecs: 300,    displaySecs: 60,
    pricePence:  { 1: 1500,  2: 700,   3: 700   },
  },
  {
    key: '30m',  label: '30 minutes', durationSecs: 1800,   displaySecs: 60,
    pricePence:  { 1: 6000,  2: 3000,  3: 3000  },
  },
  {
    key: '1h',   label: '1 hour',     durationSecs: 3600,   displaySecs: 60,
    pricePence:  { 1: 10000, 2: 5000,  3: 5000  },
  },
  {
    key: '1d',   label: '1 day',      durationSecs: 86400,  displaySecs: 60,
    pricePence:  { 1: 50000, 2: 25000, 3: 25000 },
  },
  {
    key: '2d',   label: '2 days',     durationSecs: 172800, displaySecs: 60,
    pricePence:  { 1: 90000, 2: 45000, 3: 45000 },
  },
];

export const SLOT_LABELS: Record<AdSlot, string> = {
  1: 'DJ Booth (Premium)',
  2: 'Back Left TV',
  3: 'Back Right TV',
};

// ── SSE ───────────────────────────────────────────────────────────────────────

type SSEClient = (data: object) => void;

// ── Per-slot state machine ─────────────────────────────────────────────────────

interface SlotState {
  current:      AdBooking | null;
  queue:        AdBooking[];
  displayTimer: ReturnType<typeof setTimeout> | null;
}

class AdManagerService {
  private _slots: Record<AdSlot, SlotState> = {
    1: { current: null, queue: [], displayTimer: null },
    2: { current: null, queue: [], displayTimer: null },
    3: { current: null, queue: [], displayTimer: null },
  };

  private _sseClients = new Set<SSEClient>();

  // ── SSE ─────────────────────────────────────────────────────────────────────

  addClient(client: SSEClient): void {
    this._sseClients.add(client);
    // Send current state for all slots immediately
    for (const _slot of [1, 2, 3] as AdSlot[]) {
      const cur = this._slots[_slot].current;
      if (cur) {
        client({ type: 'ad_show', slot: _slot, booking: this._toPublic(cur) });
      } else {
        client({ type: 'ad_idle', slot: _slot });
      }
    }
  }

  removeClient(client: SSEClient): void {
    this._sseClients.delete(client);
  }

  private _broadcast(data: object): void {
    for (const client of this._sseClients) {
      try { client(data); } catch { this._sseClients.delete(client); }
    }
  }

  // ── Booking ──────────────────────────────────────────────────────────────────

  book(params: {
    slot: AdSlot;
    headline: string;
    body?: string;
    imageUrl?: string;
    bgColor?: string;
    accentColor?: string;
    durationSecs: number;
    displaySecs?: number;
  }): AdBooking {
    const tier = AD_TIERS.find(t => t.durationSecs === params.durationSecs)
               ?? AD_TIERS[0];

    const booking: AdBooking = {
      id:          `ad_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      slot:        params.slot,
      headline:    params.headline.trim(),
      body:        params.body?.trim(),
      imageUrl:    params.imageUrl?.trim(),
      bgColor:     params.bgColor?.trim(),
      accentColor: params.accentColor?.trim(),
      displaySecs: params.displaySecs ?? tier.displaySecs,
      expiresAt:   Date.now() + params.durationSecs * 1000,
      addedAt:     Date.now(),
      status:      'active',
    };

    const slot = this._slots[params.slot];
    slot.queue.push(booking);
    console.log(`[AdManager] Booked slot ${params.slot}: "${booking.headline}" (${params.durationSecs}s total)`);

    if (!slot.current) this._showNext(params.slot);

    return booking;
  }

  cancel(id: string): boolean {
    for (const _slot of [1, 2, 3] as AdSlot[]) {
      const slot = this._slots[_slot];
      // Cancel queued
      const qi = slot.queue.findIndex(b => b.id === id);
      if (qi !== -1) {
        slot.queue[qi].status = 'cancelled';
        slot.queue.splice(qi, 1);
        return true;
      }
      // Cancel current
      if (slot.current?.id === id) {
        slot.current.status = 'cancelled';
        this._clearTimer(_slot);
        slot.current = null;
        this._showNext(_slot);
        return true;
      }
    }
    return false;
  }

  // ── Display cycle ─────────────────────────────────────────────────────────────

  private _showNext(slot: AdSlot): void {
    this._clearTimer(slot);
    const state = this._slots[slot];

    // Prune expired from queue
    const now = Date.now();
    state.queue = state.queue.filter(b => b.expiresAt > now && b.status === 'active');

    if (state.queue.length === 0) {
      state.current = null;
      this._broadcast({ type: 'ad_idle', slot });
      return;
    }

    const booking = state.queue.shift()!;
    state.current = booking;

    this._broadcast({ type: 'ad_show', slot, booking: this._toPublic(booking) });
    console.log(`[AdManager] Slot ${slot} showing: "${booking.headline}" (${booking.displaySecs}s)`);

    state.displayTimer = setTimeout(() => {
      if (state.current?.id !== booking.id) return;
      state.current = null;

      const stillAlive = booking.expiresAt > Date.now() && booking.status === 'active';
      if (stillAlive) {
        // Re-queue at back for looping
        state.queue.push(booking);
      } else {
        booking.status = 'expired';
      }

      this._showNext(slot);
    }, booking.displaySecs * 1000);
  }

  private _clearTimer(slot: AdSlot): void {
    const t = this._slots[slot].displayTimer;
    if (t) { clearTimeout(t); this._slots[slot].displayTimer = null; }
  }

  // ── State queries ─────────────────────────────────────────────────────────────

  getSlotState(slot: AdSlot) {
    const s = this._slots[slot];
    return {
      slot,
      label:   SLOT_LABELS[slot],
      current: s.current ? this._toPublic(s.current) : null,
      queued:  s.queue.length,
    };
  }

  getAllState() {
    return ([1, 2, 3] as AdSlot[]).map(s => this.getSlotState(s));
  }

  private _toPublic(b: AdBooking) {
    return {
      id:          b.id,
      slot:        b.slot,
      headline:    b.headline,
      body:        b.body,
      imageUrl:    b.imageUrl,
      bgColor:     b.bgColor,
      accentColor: b.accentColor,
      displaySecs: b.displaySecs,
      expiresAt:   b.expiresAt,
      addedAt:     b.addedAt,
      status:      b.status,
    };
  }
}

export const adManager = new AdManagerService();
